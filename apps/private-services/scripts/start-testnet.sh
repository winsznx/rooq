#!/usr/bin/env bash
# Starts the private services against Robinhood Chain testnet (46630), each as its own process with its own key.
# Secrets live in the macOS Keychain and only ever reach each service's own environment. The risk, coordinator and fee
# scalars are created by scripts/deploy-private-testnet.sh. Gas keys are created here on first use; fund their addresses.
#
#   rooq-private-coordinator, rooq-private-risk-a, rooq-private-risk-b   Grumpkin scalars fixed in the deployment
#   rooq-private-{gas-coordinator,gas-risk-a,gas-risk-b,gas-relayer,gas-queue,gas-price-relay}   EOA gas keys, separate per service
#   rooq-private-maker-seed   shielded wallet seed for the maker service
#   rooq-private-reward-{a,b}   seeds of the risk workers' shielded reward addresses
#   rooq-private-relayer-fee   seed of the relayer's shielded fee address (D-05)
#   rooq-private-{coordinator,risk-a,risk-b}-previous   optional, comma-separated retired scalars during a key rotation (D-24)
#
# Holding both risk keys on one machine does not meet LIQ-04's separate failure domains; this script can start a single
# worker (ROOQ_ONLY=risk-a) so they can run on different hosts.
#
#   apps/private-services/scripts/start-testnet.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
APP="$ROOT/apps/private-services"
LOGS="${ROOQ_LOGS:-$HOME/.rooq/private-services}"
mkdir -p "$LOGS"
export ROOQ_ENV=testnet
export RPC_URL="${RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
export PRIVATE_DEPLOYMENT_FILE="${PRIVATE_DEPLOYMENT_FILE:-$ROOT/contracts/deployments/privacy-46630.json}"
ONLY="${ROOQ_ONLY:-}"

keychain() { security find-generic-password -s "$1" -w; }
keychain_optional() { security find-generic-password -s "$1" -w 2>/dev/null || true; }
ensure_key() {
  security find-generic-password -s "$1" >/dev/null 2>&1 && return 0
  local v
  v="$(cast wallet new --json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["private_key"])')"
  printf 'add-generic-password -a rooq -s %s -l "Rooq private V1 testnet gas key (test funds only)" -w %s\n' "$1" "$v" | security -i
}
ensure_scalar() {
  security find-generic-password -s "$1" >/dev/null 2>&1 && return 0
  local v
  v="$(python3 -c 'import secrets; print(secrets.randbelow(2**252 - 1) + 1)')"
  printf 'add-generic-password -a rooq -s %s -l "Rooq private V1 testnet secret (test funds only)" -w %s\n' "$1" "$v" | security -i
}

for k in gas-coordinator gas-risk-a gas-risk-b gas-relayer gas-queue gas-price-relay; do ensure_key "rooq-private-$k"; done
for k in maker-seed reward-a reward-b relayer-fee; do ensure_scalar "rooq-private-$k"; done

for k in gas-coordinator gas-risk-a gas-risk-b gas-relayer gas-queue gas-price-relay; do
  echo "$k address $(cast wallet address --private-key "$(keychain "rooq-private-$k")")"
done

# Secrets are exported inside a subshell, so they are never on a command line visible to `ps`.
run() {
  local name="$1" file="$2"; shift 2
  [ -n "$ONLY" ] && [ "$ONLY" != "$name" ] && return 0
  echo "starting $name"
  ( export "$@"; cd "$APP" && nohup bun run "src/services/$file.ts" >"$LOGS/$name.log" 2>&1 & )
}

run read-api read-api PORT=8710
# RELAYER_MIN_FEES is asset:amount,...; left empty the relayer accepts spends without a fee note.
run relayer relayer PORT=8711 RELAYER_TX_KEY="$(keychain rooq-private-gas-relayer)" RELAYER_FEE_SEED="$(keychain rooq-private-relayer-fee)" RELAYER_MIN_FEES="${RELAYER_MIN_FEES:-}"
run queue queue PORT=8712 QUEUE_TX_KEY="$(keychain rooq-private-gas-queue)"
run coordinator coordinator PORT=8713 COORDINATOR_SK="$(keychain rooq-private-coordinator)" COORDINATOR_SK_PREVIOUS="$(keychain_optional rooq-private-coordinator-previous)" COORDINATOR_TX_KEY="$(keychain rooq-private-gas-coordinator)"
run risk-a risk PORT=8714 RISK_ID=A RISK_SK="$(keychain rooq-private-risk-a)" RISK_SK_PREVIOUS="$(keychain_optional rooq-private-risk-a-previous)" RISK_TX_KEY="$(keychain rooq-private-gas-risk-a)" RISK_REWARD_SEED="$(keychain rooq-private-reward-a)"
run risk-b risk PORT=8715 RISK_ID=B RISK_SK="$(keychain rooq-private-risk-b)" RISK_SK_PREVIOUS="$(keychain_optional rooq-private-risk-b-previous)" RISK_TX_KEY="$(keychain rooq-private-gas-risk-b)" RISK_REWARD_SEED="$(keychain rooq-private-reward-b)"
run price-relay price-relay PORT=8717 PRICE_RELAY_TX_KEY="$(keychain rooq-private-gas-price-relay)"
if [ -n "${MAKER_TERMS:-}" ]; then
  run maker maker PORT=8716 MAKER_SEED="$(keychain rooq-private-maker-seed)"
else
  echo "MAKER_TERMS not set: maker service not started"
fi
