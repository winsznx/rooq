#!/usr/bin/env bash
# Rebuilds the circuits, verification keys, Solidity verifiers and verifier bytecode with the toolchain pinned in
# zk/toolchain.lock, and writes manifest.json with their hashes. Fails if the committed verifiers or keys differ from
# what the build produces. Nothing is written into the checkout unless --update is given.
#
# Usage: scripts/repro-build.sh [--out DIR] [--src DIR] [--commit SHA] [--update] [--circuits-only] [--docker]
#   --out DIR        where the build and manifest.json go (default zk/target/repro)
#   --src DIR        source tree to build (default this checkout); verify-deployment.sh passes an extracted commit
#   --commit SHA     source commit to record when --src isn't a git checkout
#   --update         copy regenerated keys and verifiers into this checkout instead of failing on drift
#   --circuits-only  skip the forge build (zk/circuits/build.sh uses this)
#   --docker         run the same build in the linux-amd64 reference image (zk/Dockerfile.repro) with no network
# Env: REPRO_ALLOW_DRIFT=1 builds with an unpinned toolchain and REPRO_ALLOW_DIRTY=1 builds a modified tree. Either one
# marks the manifest "official": false. REPRO_CRS_DIR (default ~/.bb-crs) and REPRO_SOLC point at the CRS and solc.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd -P)"
OUT="$ROOT/zk/target/repro"
SRC="$ROOT"
COMMIT=""
UPDATE=0
CIRCUITS_ONLY=0
DOCKER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --src) SRC="$2"; shift 2 ;;
    --commit) COMMIT="$2"; shift 2 ;;
    --update) UPDATE=1; shift ;;
    --circuits-only) CIRCUITS_ONLY=1; shift ;;
    --docker) DOCKER=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
SRC="$(cd "$SRC" && pwd -P)"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
PY=(python3 -I "$HERE/repro.py")
sha256() { python3 -I -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1"; }
lock_get() { python3 -I -c 'import functools, json, sys; print(functools.reduce(lambda v, k: v[k], sys.argv[2].split("."), json.load(open(sys.argv[1]))))' "$LOCK" "$1"; }

if [ "$DOCKER" = 1 ]; then
  [ "$UPDATE" = 0 ] || { echo "--update writes into the checkout; run it natively" >&2; exit 2; }
  [ -f "$SRC/scripts/repro-build.sh" ] || { echo "$SRC has no scripts/repro-build.sh to run in the image" >&2; exit 2; }
  image="rooq-repro:$(sha256 "$SRC/zk/toolchain.lock" | cut -c1-12)"
  docker build --platform linux/amd64 -f "$SRC/zk/Dockerfile.repro" -t "$image" "$SRC/zk"
  inner=(--src /src --out /out)
  if [ -n "$COMMIT" ]; then inner+=(--commit "$COMMIT"); fi
  if [ "$CIRCUITS_ONLY" = 1 ]; then inner+=(--circuits-only); fi
  exec docker run --rm --platform linux/amd64 --network none \
    -e REPRO_ALLOW_DIRTY -e REPRO_ALLOW_DRIFT \
    -v "$SRC:/src:ro" -v "$OUT:/out" \
    "$image" /src/scripts/repro-build.sh "${inner[@]}"
fi

for dir in "$HOME/.nargo/bin" "$HOME/.bb" "$HOME/.foundry/bin"; do
  if [ -d "$dir" ]; then PATH="$dir:$PATH"; fi
done
export PATH

official=true
LOCK="$SRC/zk/toolchain.lock"
if [ ! -f "$LOCK" ]; then
  echo "$SRC has no zk/toolchain.lock; checking against $ROOT/zk/toolchain.lock, so the build can't be official"
  LOCK="$ROOT/zk/toolchain.lock"
  official=false
fi
CRS="${REPRO_CRS_DIR:-$HOME/.bb-crs}"
SOLC="$("${PY[@]}" solc-path --lock "$LOCK")"

echo "== toolchain"
if ! "${PY[@]}" toolchain --lock "$LOCK" --root "$SRC" --crs-dir "$CRS" --solc "$SOLC" --observed "$OUT/observed.json"; then
  if [ "${REPRO_ALLOW_DRIFT:-0}" != 1 ]; then
    echo "toolchain drifts from $LOCK; set REPRO_ALLOW_DRIFT=1 to build anyway (the manifest then says official: false)" >&2
    exit 1
  fi
  official=false
fi

echo "== source"
dirty=false
if [ -e "$SRC/.git" ] && [ "$(git -C "$SRC" rev-parse --show-toplevel 2>/dev/null)" = "$SRC" ]; then
  head="$(git -C "$SRC" rev-parse HEAD)"
  if [ -n "$COMMIT" ] && [ "$COMMIT" != "$head" ]; then
    echo "--commit $COMMIT doesn't match HEAD $head of $SRC" >&2
    exit 2
  fi
  COMMIT="$head"
  if [ -n "$(git -C "$SRC" --no-optional-locks status --porcelain)" ]; then dirty=true; fi
elif [ -z "$COMMIT" ]; then
  echo "--commit is required when $SRC isn't a git checkout" >&2
  exit 2
fi
echo "commit $COMMIT dirty=$dirty"
if [ "$dirty" = true ]; then
  if [ "$UPDATE" = 0 ] && [ "${REPRO_ALLOW_DIRTY:-0}" != 1 ]; then
    echo "refusing to build a modified tree; commit first or set REPRO_ALLOW_DIRTY=1 (the manifest then says official: false)" >&2
    exit 1
  fi
  official=false
fi

WORK="$OUT/work"
KEYS="$OUT/keys"
VERIFIERS="$OUT/verifiers"
LOGS="$OUT/logs"
rm -rf "$WORK" "$KEYS" "$VERIFIERS" "$LOGS" "$OUT/crs" "$OUT/forge" "$OUT/runtime" "$OUT/manifest.json" "$OUT/circuits.json" "$OUT/contracts.json"
mkdir -p "$WORK" "$KEYS" "$VERIFIERS" "$LOGS" "$OUT/crs"

# Compile in a copy, so nothing lands in the checkout and absolute paths in the artifacts don't matter.
paths=(zk/circuits contracts/src contracts/lib contracts/foundry.toml)
if [ -d "$SRC/zk/vendor" ]; then paths+=(zk/vendor); fi
(cd "$SRC" && tar -cf - --exclude=.git --exclude=zk/circuits/target "${paths[@]}") | (cd "$WORK" && tar -xf -)

head -c "$(( $(lock_get crs.bn254G1CompressedPoints) * 32 ))" "$CRS/bn254_g1_compressed.dat" > "$OUT/crs/bn254_g1_compressed.dat"
cp "$CRS/bn254_g2.dat" "$OUT/crs/bn254_g2.dat"

echo "== circuits"
CIRCUITS_DIR="$WORK/zk/circuits"
(cd "$CIRCUITS_DIR" && nargo compile --workspace) > "$LOGS/nargo.log" 2>&1 || { cat "$LOGS/nargo.log" >&2; exit 1; }
circuits=()
while IFS= read -r c; do circuits+=("$c"); done < <("${PY[@]}" circuits --dir "$CIRCUITS_DIR")

verifier_name() { awk -F_ '{for (i = 1; i <= NF; i++) printf "%s%s", toupper(substr($i, 1, 1)), substr($i, 2)} END {print "Verifier"}' <<< "$1"; }

for c in "${circuits[@]}"; do
  name="$(verifier_name "$c")"
  mkdir -p "$KEYS/$c"
  {
    bb write_vk -b "$CIRCUITS_DIR/target/$c.json" -o "$KEYS/$c" -t evm -c "$OUT/crs"
    bb write_solidity_verifier -k "$KEYS/$c/vk" -o "$VERIFIERS/$name.generated" -t evm -c "$OUT/crs"
  } > "$LOGS/bb-$c.log" 2>&1 || { cat "$LOGS/bb-$c.log" >&2; exit 1; }
  sed "s/^contract HonkVerifier is/contract $name is/" "$VERIFIERS/$name.generated" > "$VERIFIERS/$name.sol"
  rm "$VERIFIERS/$name.generated"
done
"${PY[@]}" circuit-entries --target "$CIRCUITS_DIR/target" --keys "$KEYS" --verifiers "$VERIFIERS" --out "$OUT/circuits.json" "${circuits[@]}"

echo "== committed keys and verifiers"
COMMITTED_KEYS="$SRC/zk/circuits/keys"
COMMITTED_VERIFIERS="$SRC/contracts/src/privacy/verifiers"
drifted=()
for c in "${circuits[@]}"; do
  name="$(verifier_name "$c")"
  for pair in "$KEYS/$c/vk:$COMMITTED_KEYS/$c/vk" "$KEYS/$c/vk_hash:$COMMITTED_KEYS/$c/vk_hash" "$VERIFIERS/$name.sol:$COMMITTED_VERIFIERS/$name.sol"; do
    built="${pair%%:*}"
    committed="${pair#*:}"
    if ! cmp -s "$built" "$committed"; then
      echo "DRIFT  ${committed#"$SRC"/}"
      drifted+=("$pair")
    fi
  done
done
for committed in "$COMMITTED_VERIFIERS"/*.sol; do
  if [ -e "$committed" ] && [ ! -f "$VERIFIERS/$(basename "$committed")" ]; then echo "STALE  ${committed#"$SRC"/} has no circuit in the build"; fi
done
if [ ${#drifted[@]} -gt 0 ]; then
  if [ "$UPDATE" = 0 ]; then
    echo "${#drifted[@]} committed file(s) differ from the build; zk/circuits/build.sh refreshes them" >&2
    exit 1
  fi
  [ "$SRC" = "$ROOT" ] || { echo "--update only writes into this checkout" >&2; exit 2; }
  for pair in "${drifted[@]}"; do
    mkdir -p "$(dirname "${pair#*:}")"
    cp "${pair%%:*}" "${pair#*:}"
    echo "updated ${pair#*:}"
  done
fi
echo "${#circuits[@]} circuits, $(( ${#circuits[@]} * 3 - ${#drifted[@]} )) of $(( ${#circuits[@]} * 3 )) committed files identical"
if [ "$UPDATE" = 1 ]; then
  # apps/web/scripts/sync-proving-assets.mjs serves the circuits from zk/circuits/target.
  (cd "$ROOT/zk/circuits" && nargo compile --workspace) > "$LOGS/nargo-checkout.log" 2>&1 || { cat "$LOGS/nargo-checkout.log" >&2; exit 1; }
  "${PY[@]}" toolchain-txt --lock "$LOCK" --circuits-json "$OUT/circuits.json" "${circuits[@]}" > "$COMMITTED_KEYS/toolchain.txt"
fi

contracts=()
if [ "$CIRCUITS_ONLY" = 0 ]; then
  echo "== contracts"
  cp "$VERIFIERS"/*.sol "$WORK/contracts/src/privacy/verifiers/"
  targets=(src/privacy/verifiers src/privacy/PairInputs.sol src/privacy/PrivatePairs.sol src/privacy/PrivateSpot.sol src/privacy/PrivateMarkets.sol)
  (cd "$WORK/contracts" && forge build --offline --force --build-info --use "$SOLC" \
    --out "$OUT/forge/out" --cache-path "$OUT/forge/cache" "${targets[@]}") > "$LOGS/forge.log" 2>&1 \
    || { tail -40 "$LOGS/forge.log" >&2; exit 1; }
  "${PY[@]}" contract-entries --build-info "$OUT/forge/out/build-info" --runtime-dir "$OUT/runtime" --out "$OUT/contracts.json" "${circuits[@]}"
  contracts=(--contracts-json "$OUT/contracts.json")
fi

echo "== manifest"
"${PY[@]}" manifest --circuits-json "$OUT/circuits.json" ${contracts[@]+"${contracts[@]}"} --observed "$OUT/observed.json" \
  --lock "$LOCK" --commit "$COMMIT" --dirty "$dirty" --official "$official" --out "$OUT/manifest.json"
echo "official $official"
echo "manifest $OUT/manifest.json"
echo "manifest_sha256 $(sha256 "$OUT/manifest.json")"
