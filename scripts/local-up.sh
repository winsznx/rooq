#!/usr/bin/env bash
# Starts the full Rooq stack on this machine against a fresh local anvil chain:
# anvil -> deploy -> bootstrap -> quote signer -> maker quotes, oracle relay, keeper -> indexer, API -> private chain and services -> web.
# Local only: uses anvil's public dev keys, which must never hold real funds.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="${ROOQ_LOGS:-$ROOT/.local-logs}"
mkdir -p "$LOGS"

# anvil dev accounts (public, local only)
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # creator, oracle operator
MAKER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d      # maker funds
KEEPER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6     # liquidator / keeper
SIGNER_KEY=0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e     # maker quote hot key
MAKER_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
RPC=http://127.0.0.1:8545

if ! cast chain-id --rpc-url $RPC >/dev/null 2>&1; then
  echo "starting anvil on 8545"
  nohup anvil --port 8545 --chain-id 31337 --silent >"$LOGS/anvil.log" 2>&1 &
  sleep 2
fi

if [ "${SKIP_DEPLOY:-0}" != "1" ]; then
  (cd "$ROOT/contracts" && forge build >/dev/null)
  (cd "$ROOT/contracts" && DEPLOY_ENV=local DEPLOYER_PRIVATE_KEY=$DEPLOYER_KEY forge script script/Deploy.s.sol --rpc-url local --broadcast >"$LOGS/deploy.log" 2>&1)
  SIGNER_ADDR=$(cast wallet address --private-key $SIGNER_KEY)
  (cd "$ROOT/contracts" && DEPLOY_ENV=local DEPLOYER_PRIVATE_KEY=$DEPLOYER_KEY MAKER_PRIVATE_KEY=$MAKER_KEY MAKER_SIGNER_ADDRESS=$SIGNER_ADDR forge script script/Bootstrap.s.sol --rpc-url local --broadcast >"$LOGS/bootstrap.log" 2>&1)
  grep -E "seeded|perps|SKIP|spot only" "$LOGS/bootstrap.log" || true
  node "$ROOT/scripts/sync-deployments.mjs"
  node "$ROOT/scripts/gen-abi.mjs"
fi

psql -h /tmp -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='rooq_local'" | grep -q 1 || psql -h /tmp -d postgres -c "CREATE DATABASE rooq_local"

# start NAME PORT CMD...: a port already serving (or, with -, a matching process) means it is up, so re-running this script is safe.
start() {
  local name=$1 port=$2; shift 2
  if [ "$port" = "-" ]; then pgrep -f "src/$name\.ts|--$name" >/dev/null && { echo "$name already running"; return 0; }
  elif lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then echo "$name already on $port"; return 0; fi
  echo "starting $name"; nohup "$@" >"$LOGS/$name.log" 2>&1 &
}
cd "$ROOT/apps/maker"
start maker 8701 env ROOQ_ENV=local QUOTE_SIGNER_PRIVATE_KEY=$SIGNER_KEY MAKER_ADDRESS=$MAKER_ADDR bun run src/quote-server.ts
start relay - env ROOQ_ENV=local ORACLE_OPERATOR_PRIVATE_KEY=$DEPLOYER_KEY bun run src/relay.ts
start keeper - env ROOQ_ENV=local KEEPER_PRIVATE_KEY=$KEEPER_KEY bun run src/keeper.ts
cd "$ROOT/apps/indexer"
bun run src/migrate.ts >"$LOGS/migrate.log" 2>&1 || { echo "migration failed, see $LOGS/migrate.log"; exit 1; }
start indexer - env ROOQ_ENV=local bun run src/main.ts --indexer
cd "$ROOT/apps/api"
start api 8700 env ROOQ_ENV=local bun run src/main.ts
cd "$ROOT"
start private-services 8710 pnpm --filter @rooq/private-services start:local
cd "$ROOT/apps/web"
start web 3200 pnpm dev
echo "web http://localhost:3200  api http://127.0.0.1:8700/api/v1  maker http://127.0.0.1:8701  private read http://127.0.0.1:8710  relayer http://127.0.0.1:8711  chain :8545, private chain :8548  logs $LOGS"
