#!/usr/bin/env bash
# Deploys Rooq to Robinhood Chain testnet (46630). Requires a funded deployer key.
#   DEPLOYER_PRIVATE_KEY  funded with testnet ETH (about 0.001 ETH covers the core deploy at 0.02 gwei)
#   MAKER_PRIVATE_KEY     holds testnet USDG to commit as maker backing (can equal the deployer)
#   MAKER_SIGNER_ADDRESS  optional hot key allowed to sign quotes for the maker
# Order: chain check -> dry run -> confirm -> broadcast -> bootstrap -> verify source -> sync addresses.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC="${RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY}"
: "${MAKER_PRIVATE_KEY:?set MAKER_PRIVATE_KEY}"

CHAIN_ID=$(cast chain-id --rpc-url "$RPC")
[ "$CHAIN_ID" = "46630" ] || { echo "RPC reports chain $CHAIN_ID, expected 46630. Refusing."; exit 1; }
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
echo "deployer $DEPLOYER balance $(cast balance "$DEPLOYER" --rpc-url "$RPC" --ether) ETH"

cd "$ROOT/contracts"
forge build
echo "== dry run"
DEPLOY_ENV=testnet forge script script/Deploy.s.sol --rpc-url "$RPC"
read -r -p "Broadcast to Robinhood Chain testnet? Type DEPLOY to continue: " answer
[ "$answer" = "DEPLOY" ] || { echo "aborted"; exit 1; }
DEPLOY_ENV=testnet forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow
echo "== bootstrap (skips any step without real balances)"
DEPLOY_ENV=testnet forge script script/Bootstrap.s.sol --rpc-url "$RPC" --broadcast --slow
echo "== source verification"
"$ROOT/scripts/verify-testnet.sh"
node "$ROOT/scripts/sync-deployments.mjs"
echo "done. Record addresses, tx hashes and blocks in docs/DEPLOYMENTS.md from contracts/broadcast/*/46630/run-latest.json"
