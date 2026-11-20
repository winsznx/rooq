#!/usr/bin/env bash
# Compiles the Rooq circuits and refreshes the committed verification keys, the Solidity verifiers in
# contracts/src/privacy/verifiers and keys/toolchain.txt. The work happens in scripts/repro-build.sh, so the developer
# build and the reproducible build share one code path (ADR-P10, DEPLOY-04).
set -euo pipefail
exec "$(cd "$(dirname "$0")/../.." && pwd)/scripts/repro-build.sh" --update --circuits-only "$@"
