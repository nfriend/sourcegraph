import * as lsp from 'vscode-languageserver-protocol'
import { ConnectionCache, DocumentCache, ResultChunkCache } from './cache'
import { dbFilename, mustGet, NoLSIFDumpError } from './util'
import { XrepoDatabase } from './xrepo'
import { TracingContext, logAndTraceCall, addTags, logSpan } from './tracing'
import * as constants from './constants'
import { Database, sortMonikers, createRemoteUri } from './database'
import { ConfigurationFetcher } from './config'
import { DocumentData, MonikerData, DefinitionModel, ReferenceModel, PackageInformationData } from './database.models'
import { uniqWith, isEqual } from 'lodash'
import { LsifDump, DumpId } from './xrepo.models'

/**
 * The number of external repositories to search if a limit is not supplied.
 */
export const DEFAULT_REFERENCE_PAGINATION_LIMIT = 50

/**
 * Context describing the current request for paginated results.
 */
export interface ReferencePaginationContext {
    /**
     * The maximum number of external repositories to search.
     */
    limit?: number

    /**
     * Context describing the previous page of results.
     */
    cursor?: ReferencePaginationCursor
}

/**
 * Context describing the previous page of results.
 */
export interface ReferencePaginationCursor {
    /**
     * TODO
     */
    dumpId: number

    /**
     * TODO
     */
    scheme: string

    /**
     * TODO
     */
    identifier: string

    /**
     * TODO
     */
    name: string

    /**
     * TODO
     */
    version: string | null

    /**
     * The number of external repositories to skip.
     */
    offset: number
}

/**
 * A wrapper around code intelligence operations.
 */
export class Backend {
    private connectionCache = new ConnectionCache(constants.CONNECTION_CACHE_CAPACITY)
    private documentCache = new DocumentCache(constants.DOCUMENT_CACHE_CAPACITY)
    private resultChunkCache = new ResultChunkCache(constants.RESULT_CHUNK_CACHE_CAPACITY)

    /**
     * Create a new `Backend`.
     *
     * @param storageRoot The path where SQLite databases are stored.
     * @param xrepoDatabase The cross-repo database.
     * @param fetchConfiguration A function that returns the current configuration.
     */
    constructor(
        private storageRoot: string,
        private xrepoDatabase: XrepoDatabase,
        private fetchConfiguration: ConfigurationFetcher
    ) {}

    /**
     * Determine if data exists for a particular document in this database.
     *
     * @param repository The repository name.
     * @param commit The commit.
     * @param path The path o fthe document.
     * @param ctx The tracing context.
     */
    public async exists(repository: string, commit: string, path: string, ctx: TracingContext = {}): Promise<boolean> {
        try {
            const { database, dump } = await this.loadClosestDatabase(repository, commit, path, ctx)
            return await database.exists(this.pathToDatabase(dump.root, path))
        } catch (e) {
            if (e instanceof NoLSIFDumpError) {
                return false
            }
            throw e
        }
    }

    /**
     * Return the location for the definition of the reference at the given position.
     *
     * @param repository The repository name.
     * @param commit The commit.
     * @param path The path of the document to which the position belongs.
     * @param position The current hover position.
     * @param ctx The tracing context.
     */
    public async definitions(
        repository: string,
        commit: string,
        path: string,
        position: lsp.Position,
        ctx: TracingContext = {}
    ): Promise<lsp.Location[]> {
        const { database, dump, ctx: newCtx } = await this.loadClosestDatabase(repository, commit, path, ctx)

        // Try to find definitions in the same dump.
        const definitions = (await database.definitions(this.pathToDatabase(dump.root, path), position, newCtx)).map(
            loc => this.locationFromDatabase(dump.root, loc)
        )
        if (definitions.length > 0) {
            return definitions
        }

        // Try to find definitions in other dumps
        const { document, ranges } = await database.getRangeByPosition(
            this.pathToDatabase(dump.root, path),
            position,
            ctx
        )
        if (!document || ranges.length === 0) {
            return []
        }

        // First, we find the monikers for each range, from innermost to
        // outermost, such that the set of monikers for reach range is sorted by
        // priority. Then, we perform a search for each moniker, in sequence,
        // until valid results are found.
        for (const range of ranges) {
            const monikers = sortMonikers(
                Array.from(range.monikerIds).map(id => mustGet(document.monikers, id, 'moniker'))
            )

            for (const moniker of monikers) {
                if (moniker.kind === 'import') {
                    // This symbol was imported from another database. See if we have xrepo
                    // definition for it.

                    const remoteDefinitions = await this.lookupMoniker(document, moniker, DefinitionModel, ctx)
                    if (remoteDefinitions) {
                        return remoteDefinitions
                    }
                } else {
                    // This symbol was not imported from another database. We search the definitions
                    // table of our own database in case there was a definition that wasn't properly
                    // attached to a result set but did have the correct monikers attached.

                    const localDefinitions = (await database.monikerResults(DefinitionModel, moniker, ctx)).map(loc =>
                        this.locationFromDatabase(dump.root, loc)
                    )

                    if (localDefinitions) {
                        return localDefinitions
                    }
                }
            }
        }
        return []
    }

    /**
     * Find the locations attached to the target moniker outside of the current database. If
     * the moniker has attached package information, then the cross-repo database is queried
     * for the target package. That database is opened, and its definitions table is queried
     * for the target moniker.
     *
     * @param document The document containing the definition.
     * @param moniker The target moniker.
     * @param model The target model.
     * @param ctx The tracing context.
     */
    private async lookupMoniker(
        document: DocumentData,
        moniker: MonikerData,
        model: typeof DefinitionModel | typeof ReferenceModel,
        ctx: TracingContext = {}
    ): Promise<lsp.Location[]> {
        if (!moniker.packageInformationId) {
            return []
        }

        const packageInformation = document.packageInformation.get(moniker.packageInformationId)
        if (!packageInformation) {
            return []
        }

        logSpan(ctx, 'package_information', {
            moniker,
            packageInformation,
        })

        const packageEntity = await this.xrepoDatabase.getPackage(
            moniker.scheme,
            packageInformation.name,
            packageInformation.version
        )
        if (!packageEntity) {
            return []
        }

        logSpan(ctx, 'package_entity', {
            moniker,
            packageInformation,
            packageRepository: packageEntity.dump.repository,
            packageCommit: packageEntity.dump.commit,
        })

        const db = new Database(
            this.connectionCache,
            this.documentCache,
            this.resultChunkCache,
            packageEntity.dump.id,
            dbFilename(
                this.storageRoot,
                packageEntity.dump.id,
                packageEntity.dump.repository,
                packageEntity.dump.commit
            )
        )

        return (await db.monikerResults(model, moniker, ctx)).map(loc =>
            mapLocation(
                uri => createRemoteUri(packageEntity, uri),
                this.locationFromDatabase(packageEntity.dump.root, loc)
            )
        )
    }

    /**
     * Find the references of the target moniker outside of the current database. If the moniker
     * has attached package information, then the cross-repo database is queried for the packages
     * that require this particular moniker identifier. These databases are opened, and their
     * references tables are queried for the target moniker.
     *
     * @param document The document containing the definition.
     * @param dumpId The ID of the dump for which this database answers queries.
     * @param moniker The target moniker.
     * @param paginationContext Context describing the current request for paginated results.
     * @param ctx The tracing context.
     */
    private async remoteReferences(
        dumpId: DumpId,
        moniker: Pick<MonikerData, 'scheme' | 'identifier'>,
        packageInformation: Pick<PackageInformationData, 'name' | 'version'>,
        limit: number = DEFAULT_REFERENCE_PAGINATION_LIMIT,
        offset: number = 0,
        ctx: TracingContext = {}
    ): Promise<{ locations: lsp.Location[]; count: number; cursor?: ReferencePaginationCursor }> {
        const { references, count } = await this.xrepoDatabase.getReferences({
            scheme: moniker.scheme,
            identifier: moniker.identifier,
            name: packageInformation.name,
            version: packageInformation.version,
            limit,
            offset,
        })

        logSpan(ctx, 'package_references', {
            references: references.map(r => ({ repository: r.dump.repository, commit: r.dump.commit })),
        })

        let locations: lsp.Location[] = []
        for (const reference of references) {
            // Skip the remote reference that show up for ourselves - we've already gathered
            // these in the previous step of the references query.
            if (reference.dump.id === dumpId) {
                continue
            }

            const db = new Database(
                this.connectionCache,
                this.documentCache,
                this.resultChunkCache,
                reference.dump.id,
                dbFilename(this.storageRoot, reference.dump.id, reference.dump.repository, reference.dump.commit)
            )

            const references = (await db.monikerResults(ReferenceModel, moniker, ctx)).map(loc =>
                mapLocation(uri => createRemoteUri(reference, uri), this.locationFromDatabase(reference.dump.root, loc))
            )
            locations = locations.concat(references)
        }

        const cursor = {
            dumpId,
            scheme: moniker.scheme,
            identifier: moniker.identifier,
            name: packageInformation.name,
            version: packageInformation.version,
            offset: offset + limit,
        }

        return { locations, count, cursor }
    }

    /**
     * Return a list of locations which reference the definition at the given position.
     *
     * @param repository The repository name.
     * @param commit The commit.
     * @param path The path of the document to which the position belongs.
     * @param position The current hover position.
     * @param paginationContext Context describing the current request for paginated results.
     * @param ctx The tracing context.
     */
    public async references(
        repository: string,
        commit: string,
        path: string,
        position: lsp.Position,
        paginationContext?: ReferencePaginationContext,
        ctx: TracingContext = {}
    ): Promise<{ locations: lsp.Location[]; cursor?: ReferencePaginationCursor }> {
        if (paginationContext && paginationContext.cursor) {
            const moniker = { scheme: paginationContext.cursor.scheme, identifier: paginationContext.cursor.identifier }
            const packageInformation = {
                name: paginationContext.cursor.name,
                version: paginationContext.cursor.version,
            }

            const { locations: remoteResults, cursor: newCursor } = await this.remoteReferences(
                paginationContext.cursor.dumpId,
                moniker,
                packageInformation,
                paginationContext.limit,
                paginationContext.cursor.offset,
                ctx
            )

            return {
                // TODO - determine source of duplication (and below)
                locations: uniqWith(remoteResults, isEqual),
                cursor: newCursor,
            }
        }

        const { database, dump, ctx: newCtx } = await this.loadClosestDatabase(repository, commit, path, ctx)
        let locations = (await database.references(this.pathToDatabase(dump.root, path), position, newCtx)).map(loc =>
            this.locationFromDatabase(dump.root, loc)
        )

        // Try to find definitions in other dumps
        const { document, ranges } = await database.getRangeByPosition(
            this.pathToDatabase(dump.root, path),
            position,
            ctx
        )
        if (!document || ranges.length === 0) {
            return { locations: [] }
        }

        // Next, we do a moniker search in two stages, described below. We process the
        // monikers for each range sequentially in order of priority for each stage, such
        // that import monikers, if any exist, will be processed first.

        for (const range of ranges) {
            const monikers = sortMonikers(
                Array.from(range.monikerIds).map(id => mustGet(document.monikers, id, 'monikers'))
            )

            // Next, we search the references table of our own database - this search is necessary,
            // but may be un-intuitive, but remember that a 'Find References' operation on a reference
            // should also return references to the definition. These are not necessarily fully linked
            // in the LSIF data.

            for (const moniker of monikers) {
                locations = locations.concat(
                    (await database.monikerResults(ReferenceModel, moniker, ctx)).map(loc =>
                        this.locationFromDatabase(dump.root, loc)
                    )
                )
            }

            // Next, we perform an xrepo search for uses of each nonlocal moniker. We stop processing after
            // the first moniker for which we received results. As we process monikers in an order that
            // considers moniker schemes, the first one to get results should be the most desirable.

            for (const moniker of monikers) {
                if (moniker.kind === 'import') {
                    // Get locations in the defining package
                    locations = locations.concat(await this.lookupMoniker(document, moniker, ReferenceModel, ctx))
                }

                if (!moniker.packageInformationId) {
                    continue
                }

                const packageInformation = document.packageInformation.get(moniker.packageInformationId)
                if (!packageInformation) {
                    continue
                }

                logSpan(ctx, 'package_information', {
                    moniker,
                    packageInformation,
                })

                const { locations: remoteResults, cursor: newCursor } = await this.remoteReferences(
                    dump.id,
                    moniker,
                    packageInformation,
                    paginationContext && paginationContext.limit,
                    paginationContext && paginationContext.cursor && paginationContext.cursor.offset,
                    ctx
                )

                if (!remoteResults) {
                    continue
                }

                return {
                    // TODO - determine source of duplication (and below)
                    locations: uniqWith(locations.concat(remoteResults), isEqual),
                    cursor: newCursor,
                }
            }
        }

        return { locations: uniqWith(locations, isEqual) }
    }

    /**
     * Return the hover content for the definition or reference at the given position.
     *
     * @param repository The repository name.
     * @param commit The commit.
     * @param path The path of the document to which the position belongs.
     * @param position The current hover position.
     * @param ctx The tracing context.
     */
    public async hover(
        repository: string,
        commit: string,
        path: string,
        position: lsp.Position,
        ctx: TracingContext = {}
    ): Promise<lsp.Hover | null> {
        const { database, dump, ctx: newCtx } = await this.loadClosestDatabase(repository, commit, path, ctx)
        return await database.hover(this.pathToDatabase(dump.root, path), position, newCtx)
    }

    /**
     * Create a database instance for the given repository at the commit
     * closest to the target commit for which we have LSIF data. Returns
     * undefined if no such database can be created. Will also return a
     * tracing context tagged with the closest commit found. This new
     * tracing context should be used in all downstream requests so that
     * the original commit and the effective commit are both known.
     *
     * @param repository The repository name.
     * @param commit The target commit.
     * @param file One of the files in the dump.
     * @param ctx The tracing context.
     */
    private async loadClosestDatabase(
        repository: string,
        commit: string,
        file: string,
        ctx: TracingContext = {}
    ): Promise<{ database: Database; dump: LsifDump; ctx: TracingContext }> {
        return await logAndTraceCall(ctx, 'loading closest database', async ctx => {
            // Determine the closest commit that we actually have LSIF data for. If the commit is
            // not tracked, then commit data is requested from gitserver and insert the ancestors
            // data for this commit.
            const dump = await logAndTraceCall(ctx, 'determining closest commit', (ctx: TracingContext) =>
                this.xrepoDatabase.findClosestDump(repository, commit, file, ctx, this.fetchConfiguration().gitServers)
            )
            if (!dump) {
                throw new NoLSIFDumpError()
            }

            return {
                database: new Database(
                    this.connectionCache,
                    this.documentCache,
                    this.resultChunkCache,
                    dump.id,
                    dbFilename(this.storageRoot, dump.id, dump.repository, dump.commit)
                ),
                dump,
                ctx: addTags(ctx, { closestCommit: dump.commit }),
            }
        })
    }

    /**
     * Converts a file in the repository to the corresponding file in the
     * database.
     *
     * @param root The root of the dump.
     * @param path The path within the dump.
     */
    private pathToDatabase(root: string, path: string): string {
        return path.startsWith(root) ? path.slice(root.length) : path
    }

    /**
     * Converts a file in the database to the corresponding file in the
     * repository.
     *
     * @param root The root of the dump.
     * @param path The path within the dump.
     */
    private pathFromDatabase(root: string, path: string): string {
        return `${root}${path}`
    }

    /**
     * Converts a location in the database to the corresponding location in the
     * repository.
     */
    private locationFromDatabase(root: string, { uri, range }: lsp.Location): lsp.Location {
        return lsp.Location.create(this.pathFromDatabase(root, uri), range)
    }
}

function mapLocation(map: (uri: string) => string, { uri, range }: lsp.Location): lsp.Location {
    return lsp.Location.create(map(uri), range)
}
