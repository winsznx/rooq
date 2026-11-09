#!/usr/bin/env bash
# Deploys the private pairs candidate to Robinhood Chain testnet (46630) and verifies it on Sourcify.
# Keys live in the macOS Keychain and only ever reach this process's environment:
#   rooq-testnet-46630-deployer, rooq-private-coordinator, rooq-private-risk-a, rooq-private-risk-b, rooq-private-fee
# Risk and coordinator keys are created on first use. Holding both risk keys on one machine does not meet LIQ-04's
# separate failure domains; they must move to separate operators before market activation.
#
#   scripts/deploy-private-testnet.sh            simulate against the live chain, no transactions
#   scripts/deploy-private-testnet.sh --broadcast
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC=https://rpc.testnet.chain.robinhood.com
USDG=0x7E955252E15c84f5768B83c41a71F9eba181802F
TSLA=0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E

keychain() { security find-generic-password -s "$1" -w; }
ensure_scalar() {
  security find-generic-password -s "$1" >/dev/null 2>&1 && return 0
  local v
  # Below the Grumpkin scalar field (the BN254 base field), so it is always a valid scalar.
  v="$(python3 -c 'import secrets; print(secrets.randbelow(2**252 - 1) + 1)')"
  printf 'add-generic-password -a rooq -s %s -l "Rooq private V1 testnet key (test funds only)" -w %s\n' "$1" "$v" | security -i
}
ensure_key() {
  security find-generic-password -s "$1" >/dev/null 2>&1 && return 0
  local v
  v="$(cast wallet new --json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["private_key"])')"
  printf 'add-generic-password -a rooq -s %s -l "Rooq private V1 testnet gas key (test funds only)" -w %s\n' "$1" "$v" | security -i
}
for k in rooq-private-coordinator rooq-private-risk-a rooq-private-risk-b rooq-private-fee; do ensure_scalar "$k"; done
# The feeds are handed to this key once deployed, so the deployer key never goes on the relay's server.
ensure_key rooq-private-gas-price-relay

export DEPLOYER_PRIVATE_KEY; DEPLOYER_PRIVATE_KEY="$(keychain rooq-testnet-46630-deployer)"
eval "$(cd "$ROOT/e2e" && COORDINATOR_SK="$(keychain rooq-private-coordinator)" RISK_A_SK="$(keychain rooq-private-risk-a)" RISK_B_SK="$(keychain rooq-private-risk-b)" FEE_SEED="$(keychain rooq-private-fee)" bun run private/print-public-keys.ts 2>/dev/null)"
: "${COORDINATOR_X:?could not derive public keys}" "${RISK_A_X:?}" "${RISK_B_X:?}" "${FEE_AUTH:?}"
export COORDINATOR_X COORDINATOR_Y RISK_A_X RISK_A_Y RISK_B_X RISK_B_Y FEE_AUTH FEE_X FEE_Y
export PRIVACY_ASSET="$USDG" PRIVACY_OUT="./deployments/privacy-46630.json"
export PRIVACY_RELAY_OPERATOR; PRIVACY_RELAY_OPERATOR="$(cast wallet address --private-key "$(keychain rooq-private-gas-price-relay)")"
AMZN=0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02
PLTR=0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0
NFLX=0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93
AMD=0x71178BAc73cBeb415514eB542a8995b82669778d
export PRIVACY_SPOT_TOKENS="$TSLA,$AMZN,$PLTR,$NFLX,$AMD"
export PRIVACY_PERP_TOKENS="$PRIVACY_SPOT_TOKENS"
# Prices are fetched now and tickers come from the verified registry by address; a failed fetch stops the deployment.
eval "$(cd "$ROOT/apps/private-services" && bun run scripts/print-start-prices.ts)"
: "${PRIVACY_PERP_SYMBOLS:?could not fetch start prices}" "${PRIVACY_PERP_PRICES_8:?could not fetch start prices}"
export PRIVACY_PERP_SYMBOLS PRIVACY_PERP_PRICES_8
PRIVACY_TIER_COUNT="$(python3 -I -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["tiers"]))' "$ROOT/config/risk-testnet.json")"
export PRIVACY_TIER_COUNT

deployer="$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")"
echo "deployer $deployer balance $(cast balance "$deployer" --rpc-url "$RPC" --ether) ETH"
cd "$ROOT/contracts"

web_env() {
  python3 -I - "$ROOT/contracts/deployments/privacy-46630.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("NEXT_PUBLIC_PRIVATE_MARKET_MAP=" + d["marketMap"])
print("NEXT_PUBLIC_PRIVATE_POOL_MAP=" + d["poolMap"])
PY
}

if [ "${1:-}" != "--broadcast" ]; then
  forge script script/DeployPrivatePairs.s.sol --rpc-url "$RPC" 2>&1 | tail -12
  echo "simulation only; pass --broadcast to deploy"
  web_env
  exit 0
fi

forge script script/DeployPrivatePairs.s.sol --rpc-url "$RPC" --broadcast --slow
"$ROOT/scripts/verify-private-testnet.sh"
web_env
