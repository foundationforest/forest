#!/usr/bin/env bash
# Runs one of the carrier's two pieces from its env file (copy the .env.example and fill it in):
#
#   ./run.sh relay        bin/relay serve, from relay.env
#   ./run.sh jetstream    bin/jetstream, from jetstream.env
#
# Relative paths in the env files are relative to carrier/. Run the relay first.
set -euo pipefail
cd "$(dirname "$0")"
piece="${1:-}"
case "$piece" in
  relay) args=(serve) ;;
  jetstream) args=() ;;
  *) echo "usage: ./run.sh relay|jetstream" >&2; exit 1 ;;
esac
[ -x "bin/$piece" ] || { echo "no bin/$piece; run ./build.sh" >&2; exit 1; }
if [ -f "$piece.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "./$piece.env"
  set +a
fi
exec "bin/$piece" "${args[@]}"
