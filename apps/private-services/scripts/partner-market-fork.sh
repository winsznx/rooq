#!/usr/bin/env bash
# Runs the whole partner-market flow against a local anvil fork of Robinhood Chain testnet (46630): deploy-feed, Safe schedule,
# 48h warp, Safe execute, a relay-style price write, create-market, status. Nothing is sent to testnet.
#
# The real Safe owner keys are not on this machine, so the fork swaps the three owners for anvil test accounts by calling
# Safe.swapOwner as the Safe itself. Every governance step after that goes through the real Safe v1.4.1 signature check with
# EIP-712 signatures from two of those test keys. The bond's USDG is moved to the creator from the shielded pool, impersonated.
#
#   apps/private-services/scripts/partner-market-fork.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
APP="$ROOT/apps/private-services"
FORK_URL="${FORK_URL:-https://rpc.testnet.chain.robinhood.com}"
PORT="${FORK_PORT:-8599}"
RPC="http://127.0.0.1:$PORT"
SYMBOL="QHT"
PRICE="1.00"
WORK="$(mktemp -d)"
DEPLOYMENT="$ROOT/contracts/deployments/privacy-46630.json"
json() { python3 -c "import json,sys; d=json.load(open('$DEPLOYMENT')); print(eval(sys.argv[1]))" "$1"; }

SAFE="$(json "d['governance']['safe']")"
POOL="$(json "d['pool']")"
USDG="$(json "d['asset']")"
RELAY="$(json "d['relayOperator']")"
SENTINEL=0x0000000000000000000000000000000000000001

# anvil's default mnemonic accounts 0..3; public test keys, never used on a real network.
CREATOR_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
SIGNER_KEYS=(0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d 0x5de4111afa1a4b94908f83103eb1d1706367c2e68ca870fc3f63d1ab4ec1fa1a 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6)

anvil --fork-url "$FORK_URL" --port "$PORT" --silent >"$WORK/anvil.log" 2>&1 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true; rm -rf "$WORK"' EXIT
for _ in $(seq 1 60); do cast chain-id -r "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
[ "$(cast chain-id -r "$RPC")" = 46630 ] || { echo "fork did not come up as 46630"; exit 1; }

echo "== fork: replace the Safe owners with test keys"
cast rpc anvil_setBalance "$SAFE" 0x8AC7230489E80000 -r "$RPC" >/dev/null
cast rpc anvil_impersonateAccount "$SAFE" -r "$RPC" >/dev/null
prev=$SENTINEL
for i in 0 1 2; do
  old="$(cast call "$SAFE" 'getOwners()(address[])' -r "$RPC" | tr -d '[] ' | cut -d, -f$((i + 1)))"
  new="$(cast wallet address "${SIGNER_KEYS[$i]}")"
  cast send "$SAFE" 'swapOwner(address,address,address)' "$prev" "$old" "$new" --from "$SAFE" --unlocked -r "$RPC" >/dev/null
  prev=$new
done
cast rpc anvil_stopImpersonatingAccount "$SAFE" -r "$RPC" >/dev/null
echo "owners now $(cast call "$SAFE" 'getOwners()(address[])' -r "$RPC"), threshold $(cast call "$SAFE" 'getThreshold()(uint256)' -r "$RPC")"

echo "== fork: partner test token and bond funding"
(cd "$ROOT/contracts" && forge build --skip test >/dev/null)
TOKEN="$(cd "$ROOT/contracts" && forge create src/tokens/MockERC20.sol:MockERC20 --broadcast -r "$RPC" --private-key "$CREATOR_KEY" \
  --constructor-args "QHooks Test Token" "$SYMBOL" 18 1000000000000000000000 | awk '/Deployed to:/ {print $3}')"
echo "partner token $TOKEN"
CREATOR="$(cast wallet address "$CREATOR_KEY")"
cast rpc anvil_setBalance "$POOL" 0x8AC7230489E80000 -r "$RPC" >/dev/null
cast rpc anvil_impersonateAccount "$POOL" -r "$RPC" >/dev/null
cast send "$USDG" 'transfer(address,uint256)' "$CREATOR" 150000000 --from "$POOL" --unlocked -r "$RPC" >/dev/null
cast rpc anvil_stopImpersonatingAccount "$POOL" -r "$RPC" >/dev/null

export RPC_URL="$RPC" PARTNER_STATE="$WORK/partner.json" PARTNER_TX_KEY="$CREATOR_KEY"
export SAFE_SIGNER_1="${SIGNER_KEYS[0]}" SAFE_SIGNER_2="${SIGNER_KEYS[1]}" SAFE_SIGNER_3="${SIGNER_KEYS[2]}"
pm() { (cd "$APP" && bun run scripts/partner-market.ts "$@" --symbol "$SYMBOL"); }

echo "== deploy-feed"
pm deploy-feed --token "$TOKEN" --price "$PRICE"
pm deploy-feed --token "$TOKEN" --price "$PRICE" --send
echo "== schedule"
pm schedule
pm schedule --send
echo "== execute before the delay (dry run must report Waiting)"
pm execute | tee "$WORK/early.txt"
grep -q "Waiting" "$WORK/early.txt"

echo "== warp 48h"
cast rpc evm_increaseTime 172801 -r "$RPC" >/dev/null
cast rpc evm_mine -r "$RPC" >/dev/null
pm execute --send

echo "== price relay write (impersonated relay operator, fixed reference with jitter as the relay would)"
FEED="$(python3 -c "import json; print(json.load(open('$PARTNER_STATE'))['feed'])")"
cast rpc anvil_setBalance "$RELAY" 0x8AC7230489E80000 -r "$RPC" >/dev/null
cast rpc anvil_impersonateAccount "$RELAY" -r "$RPC" >/dev/null
cast send "$FEED" 'setAnswer(int256)' 100120000 --from "$RELAY" --unlocked -r "$RPC" >/dev/null
cast rpc anvil_stopImpersonatingAccount "$RELAY" -r "$RPC" >/dev/null

echo "== create-market"
pm create-market
pm create-market --send
echo "== status"
pm status | tee "$WORK/status.txt"
grep -q '"id": "100"' "$WORK/status.txt" || { echo "FAIL: market not found"; exit 1; }
echo "PASS: $SYMBOL market created through the Safe and timelock on the fork"
