# @rooq/api

REST and SSE read API under `/api/v1`. Authoritative values are read from the chain at one pinned block (returned as `anchor`); history comes from the indexer's Postgres tables. Response shapes are the types in `packages/sdk/src/api-types.ts`. The API never signs or sends a transaction.

## Commands

Run from `apps/api` (or prefix with `pnpm --filter @rooq/api run`).

| Command | What it does |
|---|---|
| `bun run src/main.ts` | Serves on `API_PORT`. Exits if the RPC serves a different chain id than `ROOQ_ENV` (or mainnet 4663). Starts anyway if the RPC is unreachable; chain routes return `NETWORK_DELAYED` until it answers. |
| `bun test` | Unit tests for the error envelope, CORS, input parsing, cursors, view builders, candles, activity text, indexer health and SSE framing. |
| `pnpm --filter @rooq/api exec tsc --noEmit` | Type check. |

The indexer (`apps/indexer`) must be running against the same `DATABASE_URL`/`DATABASE_SCHEMA` for history routes to have data.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `API_PORT` | `8700` | Listen port. |
| `ROOQ_ENV` | `local` | Chain config and deployment record. |
| `RPC_URL` | chain config | One URL or several comma-separated. 4 s timeout per request, no retries. |
| `DATABASE_URL` | `postgres://mac@localhost/rooq_local?host=/tmp` | Indexer database. |
| `DATABASE_SCHEMA` | `public` | Schema the indexer writes. |
| `MAKER_URL` | `http://127.0.0.1:8701` | Maker quote service for `/quotes/perps`. |
| `ROOQ_ALLOWED_ORIGINS` | `http://localhost:3200,http://127.0.0.1:3200` | Exact origins that get CORS headers. Everything else gets none. |
| `INDEXER_STALE_SECONDS` | `30` | An indexer heartbeat older than this reports `indexer.status = "down"`. |
| `INDEXER_MAX_LAG_BLOCKS` | `5` | Lag above this reports `behind`. |
| `SPOT_QUOTE_TTL_SECONDS` | `30` | `expiresAt` of a spot quote, from the anchor block time. |
| `LOG_LEVEL` | unset | `debug` adds Postgres notices. |

## Routes

| Route | Source | Notes |
|---|---|---|
| `GET /health` | RPC, maker `/health`, `indexer_status` | Always 200; failures show as `rpc.ok = false`, `maker.ok = false`, `indexer.status = "down"`. |
| `GET /status` | as health, plus `market_status_events`, `reconciliations`, `reorgs` | Adds per-market status detail, last reconciliation and last reorg. |
| `GET /markets?kind=&status=&limit=&cursor=` | chain; 24h stats from `trades` | `kind` = `spot`, `perp` or `both`. `status` matches `perp.effectiveStatus` for perp, `spot.status` for spot, either for both. |
| `GET /markets/:marketId` | chain; 24h stats from `trades` | 404 `NOT_FOUND` for an unknown market. |
| `GET /markets/:marketId/chart?interval=&limit=` | `trades`, `oracle_observations` | Series `pool`, `perp`, `oracle`. Only buckets with executions exist; no trades means `candles: []`. |
| `GET /markets/:marketId/trades?cursor=&limit=` | `trades` | Canonical trades only, newest first. |
| `GET /account/:wallet` | chain; position candidates from `positions` | Vault free/locked, live pairs (`getPair`, `PerpLens.health`, `estimatedLiquidationPrice`), LP shares, base token holdings. With the database down every market is checked onchain instead. |
| `GET /account/:wallet/activity?cursor=&limit=` | `raw_events` | Orphaned events stay visible as `state: "rechecking"` until the transaction is canonical again. |
| `POST /quotes/perps` | maker | Body forwarded unchanged to `MAKER_URL/quote`; the maker's status and body are returned as-is. |
| `POST /quotes/spot` | chain | `SpotRouter.quoteExactInput` plus pool reserves; price impact from reserves with the SDK helpers. |
| `POST /preflight` | chain | `MarketPreflight.previewAsset`. Body: `PreflightRequest`. |
| `GET /preflight/:marketId` | chain | `MarketPreflight.previewEligibility`. |
| `GET /transactions/:hash` | RPC, `raw_events` | `mined`/`reverted` from the receipt, `pending` from the mempool, `rechecking` when the indexer saw it only in orphaned blocks, else `notSeen`. |
| `GET /oracle/:marketId` | chain | 404 when the market has no feed. |
| `GET /fees/:marketId` | chain | Fee schedule plus `protocolFeesAccrued`, the FEES ledger balance shared by all markets. |
| `GET /stream?marketId=&lastEventId=` | `stream_events` | SSE. `id:` is the stream sequence, so `Last-Event-ID` resumes exactly. Reorged events are re-sent with `reverted: true`. `indexer.sync` frames have no id. |

Field notes:

- Big integers are decimal strings in the token's smallest unit; prices are 18-decimal quote per base.
- `change24hWad` and `volume24hQuote` come from pool swaps; `perpChange24hWad` and `perpVolume24hQuote` from perp fills. The window is the 24 h before the anchor block's timestamp. Null when there were no trades in the window.
- Oracle candles carry the number of feed updates in the bucket as `v`.
- `perp.effectiveStatus` is `CLOSE_ONLY` for an `ACTIVE` market whose feed is stale or unreadable. Only `ACTIVE` is tradeable.
- `verified` and `logoUrl` come only from an exact chain id and address match in `packages/config/src/tokens.ts` (Stock Tokens and USDG). Rooq's mocks are `isTestFixture: true`, `verified: false`, `logoUrl: null`. Any other token is `assetClass: "crypto"`, unverified.

## Errors and timeouts

Errors use `ApiErrorBody` with a fresh `requestId`; messages are fixed strings, never stack traces or node errors. Request-level codes added next to the shared vocabulary: `INVALID_REQUEST` (400/405), `NOT_FOUND` (404), `RATE_LIMITED` (429, 120 POSTs per minute per IP). History routes return 503 `INDEXER_BEHIND` while Postgres is unreachable; chain routes keep working and report `indexer.status = "down"`.

Every request has a 5 s deadline (503 `NETWORK_DELAYED`). Inside it, RPC requests time out at 4 s, maker calls at 4 s (2 s for its health), and history queries at 2.5 s. After a database failure, history queries are skipped for 2 s so an outage answers in milliseconds instead of queueing behind reconnect attempts.
