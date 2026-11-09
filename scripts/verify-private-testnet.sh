#!/usr/bin/env bash
# Verifies every contract from the private testnet broadcast on Sourcify, including the libraries each Honk verifier
# links. Needs no API key; Etherscan does not list chain 46630.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/contracts/broadcast/DeployPrivatePairs.s.sol/46630/run-latest.json"
RPC=https://rpc.testnet.chain.robinhood.com
[ -f "$RUN" ] || { echo "no broadcast at $RUN"; exit 1; }
cd "$ROOT/contracts"
python3 -I - "$RUN" <<'PY' | while IFS=$'\t' read -r address target libs; do
import json, sys
run = json.load(open(sys.argv[1]))
# `libraries` entries are file:Name:address, and the same library name exists once per verifier file.
libs = [l.split(":") for l in run.get("libraries", [])]
file_of = {a.lower(): f for f, _, a in libs}
oracle = json.load(open("deployments/privacy-46630.json"))["oracle"].lower()
for tx in run["transactions"]:
    if tx.get("transactionType") != "CREATE":
        continue
    addr = tx["contractAddress"]
    # forge leaves contractName empty for artifacts it can't match after a rebuild: the oracle adapter and the feeds.
    name = tx["contractName"] or ("OracleAdapter" if addr.lower() == oracle else "MockPriceFeed")
    if addr.lower() in file_of:
        print(addr, f"{file_of[addr.lower()]}:{name}", "", sep="\t")
    elif name.endswith("Verifier"):
        f = f"src/privacy/verifiers/{name}.sol"
        print(addr, f"{f}:{name}", " ".join(f"{p}:{n}:{a}" for p, n, a in libs if p == f), sep="\t")
    elif name in ("PrivatePairs", "PrivateMarkets"):
        print(addr, name, " ".join(f"{p}:{n}:{a}" for p, n, a in libs if n == "PairInputs"), sep="\t")
    else:
        print(addr, name, "", sep="\t")
PY
  args=()
  for l in $libs; do args+=(--libraries "$l"); done
  echo "verifying $target at $address"
  forge verify-contract "$address" "$target" --chain 46630 --rpc-url "$RPC" --verifier sourcify --guess-constructor-args ${args[@]+"${args[@]}"} --watch 2>&1 | tail -2 || echo "VERIFY FAILED: $target $address"
done
