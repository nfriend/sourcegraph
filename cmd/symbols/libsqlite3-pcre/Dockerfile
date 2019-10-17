FROM sourcegraph/builder:176b00c634@sha256:0aaa9e32b72bb2ba2b863becaa810e7a34d2f30dd1bc9420e9de347841bb5f49 as builder

ENV OUTPUT_DIR=/output
RUN mkdir -p ${OUTPUT_DIR}

WORKDIR /src
COPY . .
RUN ./build.sh

FROM alpine:3.9@sha256:644fcb1a676b5165371437feaa922943aaf7afcfa8bfee4472f6860aad1ef2a0

# hadolint ignore=DL3018
RUN apk --no-cache add pcre-dev

COPY --from=builder /output/pcre.so /libsqlite3-pcre.so
ENV LIBSQLITE3_PCRE /libsqlite3-pcre.so
