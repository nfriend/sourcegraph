#!/usr/bin/env bash

cd $(dirname "${BASH_SOURCE[0]}")/../../..
set -euxo pipefail

export MANAGEMENT_CONSOLE_PKG="github.com/sourcegraph/sourcegraph/enterprise/cmd/management-console"

./cmd/management-console/docker.sh
