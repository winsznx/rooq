#!/usr/bin/env bash
# Verifies every Rooq contract from contracts/broadcast on the Robinhood Chain testnet Blockscout explorer.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/contracts/broadcast/Deploy.s.sol/46630/run-latest.json"
[ -f "$RUN" ] || { echo "no testnet broadcast found at $RUN"; exit 1; }
cd "$ROOT/contracts"
python3 -I - "$RUN" <<'PY' | while read -r name address args; do
import json, sys
run = json.load(open(sys.argv[1]))
for tx in run["transactions"]:
    if tx.get("transactionType") == "CREATE":
        print(tx["contractName"], tx["contractAddress"], tx.get("arguments") and "1" or "0")
PY
  # foundry.toml compiles ClearingHouse alone with via-IR (profile "size"); the explorer must get the
  # same settings or the bytecode will not match.
  profile=default
  [ "$name" = "ClearingHouse" ] && profile=size
  echo "verifying $name at $address (profile $profile)"
  forge verify-contract "$address" "$name" \
    --compilation-profile "$profile" \
    --chain 46630 \
    --verifier blockscout \
    --verifier-url https://explorer.testnet.chain.robinhood.com/api/ \
    --guess-constructor-args \
    --rpc-url https://rpc.testnet.chain.robinhood.com \
    --watch || echo "VERIFY FAILED: $name $address"
done
