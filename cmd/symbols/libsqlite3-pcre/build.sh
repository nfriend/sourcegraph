#!/usr/bin/env bash

set -euxo pipefail

curl -fsSL https://codeload.github.com/ralight/sqlite3-pcre/tar.gz/c98da412b431edb4db22d3245c99e6c198d49f7a | tar -C $OUTPUT_DIR -xzvf - --strip 1
cd $OUTPUT_DIR
make
