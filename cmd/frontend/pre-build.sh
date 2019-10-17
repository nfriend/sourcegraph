#!/bin/bash
set -euxo pipefail
cd $(dirname "${BASH_SOURCE[0]}")/../..

# Start postgres (for the dev/generate.sh scripts)
gosu postgres /usr/lib/postgresql/9.6/bin/pg_ctl initdb
## Allow pgsql to listen to all IPs
## See https://stackoverflow.com/a/52381997 for more information
gosu postgres /usr/lib/postgresql/9.6/bin/pg_ctl -o "-c listen_addresses='*'" -w start

# Build the webapp typescript code.
echo "--- yarn"
yarn --frozen-lockfile --network-timeout 60000

pushd web
echo "--- yarn run build"
NODE_ENV=production DISABLE_TYPECHECKING=true yarn run build
popd

echo "--- go generate"
go generate ./cmd/frontend/internal/app/assets ./cmd/frontend/internal/app/templates ./cmd/frontend/docsite
