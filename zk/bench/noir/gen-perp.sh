#!/usr/bin/env bash
# Builds perp_open/Prover.toml: the Noir test computes every value; the maker signature comes from a real
# secp256k1 key (anvil account 1, a public test key) because Noir cannot sign.
set -euo pipefail
cd "$(dirname "$0")"
MAKER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
raw=$(nargo test --package perp_open --show-output 2>&1)
toml=$(printf '%s\n' "$raw" | grep -v -e '^W digest ' -e '^W dbg_' | python3 ../toml.py | sed 's/is_long = "0x01"/is_long = true/')
digest=0x$(printf '%s\n' "$raw" | awk '$1=="W" && $2=="digest" {printf "%02s", substr($4,3)}' | tr ' ' 0)
sig=$(cast wallet sign --no-hash --private-key "$MAKER_KEY" "$digest")
pub=$(cast wallet public-key --private-key "$MAKER_KEY")
bytes() { python3 -c "import sys;h=sys.argv[1][2:];print('[' + ', '.join(str(int(h[i:i+2],16)) for i in range(0,len(h),2)) + ']')" "$1"; }
{
  printf '%s\n' "$toml"
  echo "m = { pub_x = $(bytes 0x${pub:2:64}), pub_y = $(bytes 0x${pub:66:64}), signature = $(bytes ${sig:0:130}) }"
} > perp_open/Prover.toml
echo "digest $digest"
