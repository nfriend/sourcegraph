FROM sourcegraph/builder:176b00c634@sha256:0aaa9e32b72bb2ba2b863becaa810e7a34d2f30dd1bc9420e9de347841bb5f49 as builder

ARG CTAGS_VERSION="03f933a96d3ef87adbf9d167462d45ce69577edb"
ENV CTAGS_VERSION ${CTAGS_VERSION}

ENV OUTPUT_DIR=/output
RUN mkdir -p ${OUTPUT_DIR}

WORKDIR /src
COPY . .
RUN internal/pkg/ctags/build.sh

WORKDIR /

FROM alpine:3.9@sha256:644fcb1a676b5165371437feaa922943aaf7afcfa8bfee4472f6860aad1ef2a0

COPY .ctags.d /.ctags.d
COPY --from=builder /output/bin/universal-* /usr/local/bin/
