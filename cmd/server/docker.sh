#!/usr/bin/env bash

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
set -exo pipefail

BUILD_ARGS=(
    "DATE"
    "COMMIT_SHA"
    "VERSION"
    "FRONTEND_PKG"
    "MANAGEMENT_CONSOLE_PKG"
    "REPO_UPDATER_PKG"
    "SERVER_PKG"
    "PRE_BUILD_SCRIPT"
    "CTAGS_VERSION"
)

if [[ "$CI" == "true" ]]; then

    substitutions="_IMAGE=$IMAGE"
    for arg in "${BUILD_ARGS[@]}"; do
        if [[ "${!arg}" ]]; then
            substitutions+=",_${arg}=${!arg}"
        fi
    done

    gcloud builds submit --config=cmd/server/cloudbuild.yaml --substitutions=$substitutions --no-source
else

    build_arg_str=""
    for arg in "${BUILD_ARGS[@]}"; do
        if [[ "${!arg}" ]]; then
            build_arg_str+="--build-arg ${arg}=${!arg} "
        fi
    done

    docker build -f cmd/server/Dockerfile -t "$IMAGE" . \
        $build_arg_str \
        --progress=plain

fi
