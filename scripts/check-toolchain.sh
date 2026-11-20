#!/usr/bin/env bash
# Compares the installed nargo, bb, forge and solc, the CRS slice, the vendored Poseidon, the JS prover packages and the
# Solidity submodules to zk/toolchain.lock, and exits non-zero on any drift. scripts/repro-build.sh runs it first.
#
# Usage: scripts/check-toolchain.sh [--root DIR] [--observed FILE]
# Env: REPRO_CRS_DIR (default ~/.bb-crs), REPRO_SOLC (default: where svm installs the pinned solc).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OBSERVED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$(cd "$2" && pwd)"; shift 2 ;;
    --observed) OBSERVED="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

for dir in "$HOME/.nargo/bin" "$HOME/.bb" "$HOME/.foundry/bin"; do
  if [ -d "$dir" ]; then PATH="$dir:$PATH"; fi
done
export PATH

LOCK="$ROOT/zk/toolchain.lock"
[ -f "$LOCK" ] || LOCK="$HERE/../zk/toolchain.lock"
args=(--lock "$LOCK" --root "$ROOT" --crs-dir "${REPRO_CRS_DIR:-$HOME/.bb-crs}" --solc "$(python3 -I "$HERE/repro.py" solc-path --lock "$LOCK")")
if [ -n "$OBSERVED" ]; then args+=(--observed "$OBSERVED"); fi
exec python3 -I "$HERE/repro.py" toolchain "${args[@]}"
