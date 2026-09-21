#!/usr/bin/env bash
# Runs the host from host/pds.env (copy pds.env.example and fill in the secrets). Plain SQLite
# files under PDS_DATA_DIRECTORY, photos under PDS_BLOBSTORE_DISK_LOCATION, nothing else.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f pds.env ]; then
  echo "no host/pds.env: copy pds.env.example to pds.env and set the secrets" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. ./pds.env
set +a
# Relative paths in pds.env are relative to host/, not to where the service's entry point lives.
export PDS_DATA_DIRECTORY="$(mkdir -p "$PDS_DATA_DIRECTORY" && cd "$PDS_DATA_DIRECTORY" && pwd)"
export PDS_BLOBSTORE_DISK_LOCATION="$(mkdir -p "$PDS_BLOBSTORE_DISK_LOCATION" && cd "$PDS_BLOBSTORE_DISK_LOCATION" && pwd)"
cd upstream/services/pds
exec node --enable-source-maps index.ts
