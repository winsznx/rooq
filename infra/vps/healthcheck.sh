#!/usr/bin/env bash
# Prints every Rooq service on this host and exits non-zero if any is down, degraded or blocked.
exec /opt/rooq/tools/bin/bun run "$(dirname "$(readlink -f "$0")")/healthcheck.ts" "$@"
