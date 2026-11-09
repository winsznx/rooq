# @rooq/indexer

Reorg-safe indexer for the Rooq contracts. It stores every block header and every log from the watched contracts as source rows, derives market, position, pool, vault, funding and oracle tables from the canonical logs only, and reconciles the derived state against `eth_call` reads pinned to the same block.

## Commands

Run from `apps/indexer` (or prefix with `pnpm --filter @rooq/indexer run`).

| Command | What it does |
|---|---|
| `bun run src/migrate.ts` | Applies the SQL migrations. Idempotent. `--dry-run` lists pending migrations without applying them. |
| `bun run src/main.ts` | Verifies the chain id (refuses 4663), migrates, rebuilds derived tables from stored canonical events, then indexes forward in a loop. Stops on SIGINT/SIGTERM. |
| `bun run src/replay.ts` | Deletes the derived tables for the chain and rebuilds them from stored canonical events in one transaction. Prints table digests before and after. |
| `bun run src/reorg-drill.ts` | Starts its own anvil on 8555 forked from 8545, forces a 5-block reorg with `evm_snapshot`/`evm_revert`, asserts the result, writes `docs/evidence/indexer-reorg-local.json`. |
| `bun run src/restart-drill.ts` | Starts its own anvil on 8556 forked from 8545, runs `src/main.ts` as a child process, SIGKILLs it, sends transactions, restarts it, asserts it resumed from its cursor with no gaps or duplicates, writes `docs/evidence/indexer-restart-local.json`. |
| `bun test` | Unit tests for reducers, decoding, actor attribution and the reorg helpers. No network or database. |
| `pnpm --filter @rooq/indexer exec tsc --noEmit` | Type check. |

The drills never write to the node on 8545; they only fork it. They use the `drill_reorg` and `drill_restart` schemas and drop them at the start of each run.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `ROOQ_ENV` | `local` | `local`, `local-fork` or `testnet`; selects chain config and deployment record. |
| `RPC_URL` | chain config | One URL, or several comma-separated (viem fallback). |
| `DATABASE_URL` | `postgres://mac@localhost/rooq_local?host=/tmp` | `?host=` may name a unix socket directory. |
| `DATABASE_SCHEMA` | `public` | Postgres schema for all tables. Created if missing. |
| `INDEXER_RANGE_BLOCKS` | `2000` | Maximum blocks per fetched range. `eth_getLogs` is split in half when a provider rejects the range. |
| `INDEXER_POLL_MS` | `1000` | Wait between ticks once caught up. |
| `RECONCILE_EVERY_BLOCKS` | `20` | Reconcile after this many indexed blocks. A failed reconciliation is retried after 10 s. |
| `INDEXER_MAX_LAG_BLOCKS` | `5` | Status becomes `behind` above this lag. |
| `INDEXER_MAX_REORG_DEPTH` | `1000` | Deeper reorgs stop the indexer with status `degraded`. |
| `RPC_BATCH_SIZE` | `100` | JSON-RPC batch size. Every request has a 5 s timeout. |
| `LOG_LEVEL` | unset | `debug` prints undecoded logs and Postgres notices. |
| `DRILL_PORT` | `8555` / `8556` | Port for the drill's own anvil. |
| `DRILL_SOURCE_RPC` | `http://127.0.0.1:8545` | Node the drills fork from. |

## Data model

Source layer, never rebuilt: `chain_blocks` (every header, `canonical` flag), `raw_events` (every watched log with topics, data, decoded args, actors, `canonical` flag), `stream_events` (SSE outbox with reorg tombstones), `indexer_cursors`, `indexer_status`, `watched_addresses`, `contract_meta` (token and feed decimals), `reorgs`, `reconciliations`.

Derived layer, a pure function of canonical `raw_events` (`REDUCER_VERSION` = 1): `markets`, `positions`, `position_events`, `trades` (perp fills and pool swaps), `funding_events`, `liquidations`, `pools`, `pool_events`, `lp_balances`, `vault_movements`, `vault_balances`, `vault_state`, `oracle_observations`, `market_status_events`, `feeds`. Each event table has primary key `(chain_id, tx_hash, log_index)`.

Every uint256/int256 is `NUMERIC(78,0)`. Block numbers and timestamps are `BIGINT`.

`raw_events` is unique on `(chain_id, block_hash, log_index)`, which identifies one observation of a log, and has a partial unique index on `(chain_id, tx_hash, log_index) WHERE canonical`. A reorg can re-include the same transaction at the same log index in a new block; the partial index lets the orphaned row stay unchanged next to the new canonical one while still guaranteeing one canonical row per consumer dedupe key.

## How a tick works

1. Read the head. If it is below the cursor, or the block at the cursor height has a different hash, handle a reorg.
2. Fetch logs for `[cursor+1, cursor+range]` from every watched address: the deployment's core contracts, every recorded market's pool and feed, plus pools and feeds announced in-range by `PoolCreated`, `MarketCreated` and `FeedRegistered`.
3. Fetch every header in the range (full transactions only for blocks with logs, to record `tx.from`). The first header's parent must equal the cursor hash, each header must link to the previous one, and each log's block hash must match its header. A parent mismatch is a reorg; any other break refetches the range.
4. Reduce the range on a copy of the in-memory state and commit headers, raw events, stream rows, changed state rows, history rows and the cursor in one transaction. A crash leaves all of it or none of it.
5. Reconcile when due.

Reorg handling walks back in batches of 64 headers to the highest block whose stored canonical hash the node still agrees with, marks every later block and raw event non-canonical, writes `reverted: true` stream tombstones, rebuilds the derived tables from the remaining canonical events in the same transaction and rewinds the cursor. The next ticks index the new branch forward.

## Reconciliation

At the cursor block, with every read pinned to that block number:

- each open pair, and each pair changed since the last pass: `ClearingHouse.getPair` size, entry price, taker and maker margin, maker, realised PnL;
- each market: status, pool, long and short OI, `commitTotal`, `badDebt`, `fundingIndex`, insurance, creator bond, and the registry's market count;
- each pool: `getReserves`, `totalSupply`, `feesAccrued0/1`, `paused`;
- vault: derived ledger total against `totalLedger`, protocol fees, free and locked balances of recently changed accounts, and conservation `totalLedger <= collateral.balanceOf(vault)`. A surplus (tokens sent straight to the vault) is recorded, not treated as a failure.

Any mismatch or a reconciliation that cannot run sets `indexer_status.status = 'degraded'` with the first mismatch as the reason. Reducer invariant failures (negative balance, impossible status transition, a `BackingChanged.commitTotal` the ledger does not explain) do the same. A later passing reconciliation clears it.

## Known limits

- Startup rebuilds the derived tables from all canonical raw events. That keeps derived state equal to a replay on every start, and costs time proportional to the number of indexed events.
- Every block header in a range is fetched. That is what makes parent-hash linkage checkable, and it is the dominant RPC cost on a long backfill.
- A feed discovered through `FeedRegistered` is watched from its registration block. Answers it published earlier are not indexed. Feeds in the deployment record are watched from the deploy block.
- `Deposited`, `Withdrawn` and the other vault events are in activity but not in the SSE stream; the stream vocabulary has no vault type.
