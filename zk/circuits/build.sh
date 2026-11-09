#!/usr/bin/env bash
# Compiles the Rooq circuits, writes EVM verification keys and Solidity verifiers into contracts/src/privacy/verifiers,
# and records the artifact hashes that a deployment pins (ADR-P10, DEPLOY-04).
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.nargo/bin:$HOME/.bb:$PATH"
OUT=../../contracts/src/privacy/verifiers
mkdir -p "$OUT" keys
nargo compile --workspace
{
  echo "nargo $(nargo --version | head -1 | awk '{print $4}')"
  echo "bb $(bb --version)"
} > keys/toolchain.txt
for c in append spend lock open_pair liquidate release funding_epoch close_pair exit_request pair_update redeem_claim insurance_sweep bond_release swap lp_add lp_set lp_remove; do
  camel="$(awk -F_ '{for(i=1;i<=NF;i++) printf "%s%s", toupper(substr($i,1,1)), substr($i,2)}' <<< "$c")"
  name="${camel}Verifier"
  rm -rf "keys/$c" && mkdir -p "keys/$c"
  bb write_vk -b "target/$c.json" -o "keys/$c" -t evm >/dev/null
  bb write_solidity_verifier -k "keys/$c/vk" -o "$OUT/$name.sol" -t evm >/dev/null
  sed -i '' "s/^contract HonkVerifier is/contract $name is/" "$OUT/$name.sol"
  echo "$c circuit_sha256=$(shasum -a 256 "target/$c.json" | cut -c1-64) vk_hash=0x$(xxd -p "keys/$c/vk_hash" | tr -d '\n') verifier_sha256=$(shasum -a 256 "$OUT/$name.sol" | cut -c1-64)" >> keys/toolchain.txt
done
cat keys/toolchain.txt
