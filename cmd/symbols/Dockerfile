FROM sourcegraph/builder:176b00c634@sha256:0aaa9e32b72bb2ba2b863becaa810e7a34d2f30dd1bc9420e9de347841bb5f49 as builder

ENV OUTPUT_DIR=/output
RUN mkdir -p ${OUTPUT_DIR}

WORKDIR /src
COPY . .

ARG CTAGS_VERSION="03f933a96d3ef87adbf9d167462d45ce69577edb"
ENV CTAGS_VERSION ${CTAGS_VERSION}

ARG BUILD_TYPE="dev"
ENV BUILD_TYPE ${BUILD_TYPE}

ARG VERSION="unknown"
ENV VERSION ${VERSION}

RUN cmd/symbols/build.sh buildSymbolsDockerImage

FROM alpine:3.9@sha256:644fcb1a676b5165371437feaa922943aaf7afcfa8bfee4472f6860aad1ef2a0

ARG COMMIT_SHA="unknown"
ARG DATE="unknown"
ARG VERSION="unknown"

LABEL org.opencontainers.image.revision=${COMMIT_SHA}
LABEL org.opencontainers.image.created=${DATE}
LABEL org.opencontainers.image.version=${VERSION}
LABEL com.sourcegraph.github.url=https://github.com/sourcegraph/sourcegraph/commit/${COMMIT_SHA}

# hadolint ignore=DL3018
RUN apk add --no-cache bind-tools ca-certificates mailcap tini

# hadolint ignore=DL3022
COPY --from=builder /output/bin/universal-* /usr/local/bin/

# hadolint ignore=DL3022
COPY --from=builder /output/pcre.so /libsqlite3-pcre.so
ENV LIBSQLITE3_PCRE /libsqlite3-pcre.so
# hadolint ignore=DL3018
RUN apk --no-cache add pcre-dev

# universal-ctags doesn't support some popular languages out of the box (Scala,
# Swift, and Haskell, to name a few). However, you can add language support by
# providing regexes on the command line or in a configuration file.
# universal-ctags looks in the current working directory for config files during
# initialization:
# https://github.com/universal-ctags/ctags/blob/1b747b38589f7a1c98ac9fe0a0b8b174dd476050/docs/optlib.rst#preload-option-file
WORKDIR /
COPY cmd/symbols/.ctags.d /.ctags.d

ENV CACHE_DIR=/mnt/cache/symbols
EXPOSE 3184
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/symbols"]
COPY --from=builder /output/symbols /usr/local/bin/
