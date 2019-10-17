#!/usr/bin/env bash

set -euxo pipefail

DOWNLOAD_DIR=`mktemp -d -t sgdockerbuild_XXXXXXX`
cleanup() {
    rm -rf "$DOWNLOAD_DIR"
}
trap cleanup EXIT

curl https://codeload.github.com/universal-ctags/ctags/tar.gz/$CTAGS_VERSION | tar xz -C $DOWNLOAD_DIR

cd $DOWNLOAD_DIR/ctags-$CTAGS_VERSION
./autogen.sh
LDFLAGS=-static ./configure --program-prefix=universal- --prefix=$OUTPUT_DIR --enable-json --enable-seccomp
make -j8
make install
