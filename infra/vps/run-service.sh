#!/usr/bin/env bash
# ExecStart of rooq@.service. systemd has already loaded the env files; this only picks the entry point.
set -euo pipefail
case "${1:?service name required}" in
  read-api|relayer|queue|coordinator|maker|price-relay) entry="$1" ;;
  risk-a) entry=risk; export RISK_ID=A ;;
  risk-b) entry=risk; export RISK_ID=B ;;
  *) echo "unknown service $1" >&2; exit 64 ;;
esac
exec /opt/rooq/tools/bin/bun run "src/services/$entry.ts"
