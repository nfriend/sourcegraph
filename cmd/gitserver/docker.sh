#!/usr/bin/env bash

cd $(dirname "${BASH_SOURCE[0]}")/../..
set -euxo pipefail

docker build -f cmd/gitserver/Dockerfile -t $IMAGE . \
    --build-arg COMMIT_SHA \
    --build-arg DATE \
    --build-arg VERSION
