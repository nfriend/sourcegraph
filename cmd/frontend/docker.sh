#!/usr/bin/env bash

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
set -euxo pipefail

echo "--- docker build $IMAGE"
docker build -f cmd/frontend/Dockerfile -t $IMAGE . \
    --build-arg COMMIT_SHA \
    --build-arg DATE \
    --build-arg VERSION \
    --build-arg FRONTEND_PKG \
    --build-arg PRE_BUILD_SCRIPT
