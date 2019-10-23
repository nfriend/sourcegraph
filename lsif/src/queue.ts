import Bull, { Queue, Job, JobOptions } from 'bull'
import { Span, Tracer, FORMAT_TEXT_MAP } from 'opentracing'
import { Logger } from 'winston'
import { promisify } from 'util'
import { chunk } from 'lodash'
import { ApiJob, formatJobFromMap, formatJob } from './api-job'

/**
 * The names of queues as defined in Bull.
 */
export type QueueTypes = 'active' | 'waiting' | 'delayed' | 'completed' | 'failed'

/**
 * A mapping from job statuses to queue names.
 */
export const queueTypes = new Map<string, QueueTypes>([
    ['active', 'active'],
    ['queued', 'waiting'],
    ['scheduled', 'delayed'],
    ['completed', 'completed'],
    ['failed', 'failed'],
])

/**
 * Creates a queue instance.
 *
 * @param name The name of the queue.
 * @param endpoint The host:port redis address.
 * @param logger The logger instance.
 */
export function createQueue(name: string, endpoint: string, logger: Logger): Queue {
    const [host, port] = endpoint.split(':', 2)

    const redis = {
        host,
        port: parseInt(port, 10),
    }

    const queue = new Bull(name, { redis })
    queue.on('error', (error: Error) => logger.error('queue error', { error }))
    queue.on('global:stalled', (id: string) => logger.error('job stalled', { jobId: id }))

    return queue
}

/**
 * Enqueue a job to be run by a worker.
 *
 * @param queue The job queue.
 * @param name The name of the job class.
 * @param args The job arguments.
 * @param opts The job options.
 * @param tracer The tracer instance.
 * @param span The parent span.
 */
export const enqueue = (
    queue: Queue,
    name: string,
    args: object,
    opts: JobOptions,
    tracer?: Tracer,
    span?: Span
): Promise<Job> => {
    const tracing = {}
    if (tracer && span) {
        tracer.inject(span, FORMAT_TEXT_MAP, tracing)
    }

    return queue.add(name, { args, tracing }, opts)
}

/**
 * Schedule a job to be invoked on an interval. If this job was previously
 * scheduled with a different interval, the old instance is first unscheduled.
 *
 * @param queue The job queue.
 * @param name The name of the job class.
 * @param args The job arguments.
 * @param intervalMs How frequently to run the job.
 */
export const ensureOnlyRepeatableJob = async (
    queue: Queue,
    name: string,
    args: object,
    intervalMs: number
): Promise<void> => {
    const keys = []
    for (const job of await queue.getRepeatableJobs()) {
        if (job.name === name) {
            // Job already scheduled with correct interval
            if (job.every === intervalMs * 1000) {
                return
            }

            keys.push(job.key)
        }
    }

    for (const key of keys) {
        // Remove old scheduled jobs with different intervals
        await queue.removeRepeatableByKey(key)
    }

    // Schedule job with correct interval
    await enqueue(queue, name, args, { repeat: { every: intervalMs * 1000 } })
}

/**
 * A Lua script evaluated in Redis to return the jobs in the given queue
 * matching the given query string. This script has the following input:
 *
 *  - KEYS[1]: redis key prefix (e.g. bull:lsif:)
 *  - KEYS[2]: the name of the queues
 *
 *  - ARGV[1]: the search query
 *  - ARGV[2]: start index to scan (inclusive)
 *  - ARGV[3]: end index to scan (inclusive)
 */
const jobSearchScript = `
    local function extractValues(id, key)
        local values = {
            id,
            redis.call('HGET', key, 'name'),
            redis.call('HGET', key, 'failedReason'),
            redis.call('HGET', key, 'stacktrace'),
        }

        local data = cjson.decode(redis.call('HGET', key, 'data'))
        for _, value in pairs({'repository', 'commit', 'root'}) do
            table.insert(values, data['args'][value])
        end

        return values
    end

    local function jobMatches(id, key)
        local values = extractValues(id, key)

        for term in string.gmatch(ARGV[1], '%S+') do
            local found = false
            for _, value in pairs(values) do
                if type(value) == 'string' and string.find(value, term, 1, true) then
                    found = true
                    break
                end
            end

            if not found then
                return false
            end
        end

        return true
    end

    local command = 'ZRANGE'
    if KEYS[2] == 'active' then -- And waiting?
        command = 'LRANGE'
    end

    if KEYS[2] == 'completed' or KEYS[2] == 'failed' then
        command = 'ZREVRANGE'
    end

    local matching = {}
    for _, v in pairs(redis.call(command, KEYS[1] .. KEYS[2], ARGV[2], ARGV[3])) do
        if jobMatches(v, KEYS[1] .. v) then
            local data = redis.call('HGETALL', KEYS[1] .. v)
            table.insert(data, 'id')
            table.insert(data, v)
            table.insert(matching, data)
        end
    end

    return matching
`

/**
 * Return a list of JSON-encoded jobs with the given status and that contain the
 * given search term.
 *
 * @param queue The job queue.
 * @param status The target job status.
 * @param search The search query.
 * @param start The start index (inclusive).
 * @param end The end index (inclusive).
 */
export async function searchJobs(
    queue: Queue,
    status: string,
    search: string,
    start: number,
    end: number
): Promise<ApiJob[]> {
    const queueName = queueTypes.get(status)
    if (!queueName) {
        throw new Error(`Unknown job status ${status}`)
    }

    const evalCommand = promisify(queue.client.eval.bind(queue.client)) as (
        lua: string,
        numberOfKeys: number,
        keysAndArgs: any[]
    ) => Promise<string[][]>

    const payloads = await evalCommand(jobSearchScript, 2, ['bull:lsif:', queueName, search, start, end])

    const jobs = []
    for (const payload of payloads) {
        // Translate redis hgetall response `[k1, v2, k2, v1, ...]` into a map `{k1 -> v1, k2 -> v2, ...}`,
        // then translate the map into an ApiJob instance so we can return it from the API.
        jobs.push(formatJobFromMap(new Map<string, string>(chunk(payload, 2) as [string, string][]), status))
    }

    return jobs
}

/**
 * Return a list of JSON-encoded jobs with the given status.
 *
 * @param queue The job queue.
 * @param status The target job status.
 * @param start The start index (inclusive).
 * @param end The end index (inclusive).
 */
export async function sliceJobs(
    queue: Queue,
    status: string,
    start: number,
    end: number
): Promise<{ jobs: ApiJob[]; totalCount: number }> {
    const queueName = queueTypes.get(status)
    if (!queueName) {
        throw new Error(`Unknown job status ${status}`)
    }

    const rawJobs = await queue.getJobs([queueName], start, end)
    const jobs = rawJobs.map(job => formatJob(job, status))
    const totalCount = (await queue.getJobCountByTypes([queueName])) as never
    return { jobs, totalCount }
}
