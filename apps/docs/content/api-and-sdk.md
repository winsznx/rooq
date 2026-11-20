Rooq's services only return public chain data and encrypted records. Your keys and proofs stay on the client. If you build on Rooq, you do the decryption and proving yourself with the SDK.

## Read API

The read API holds no keys and keeps no per-client state. It's a way to fetch public chain data, and you can rebuild everything it serves from the chain yourself. The base URL is `https://api.rooq.trade`, and the paths below are relative to it.

| Route | What it returns |
| --- | --- |
| `GET /health` | Service status, chain ID and sync lag |
| `GET /v1/sync` | How far the service has read the chain |
| `GET /v1/public?from=&pricesSince=` | Everything public after block `from` in one response: tokens, spent nullifiers, exits, closes, unshields and price history since a unix time |
| `GET /v1/deployment` | Deployment ID, addresses and public keys |
| `GET /v1/records?from=&limit=` | Encrypted records, by page |
| `GET /v1/deposits?from=&limit=` | Shield events, by page |
| `GET /v1/tree/leaves?from=&limit=` | Note tree leaves |
| `GET /v1/tree/path/:index` | A proof path for one leaf |
| `POST /v1/nullifiers` | Whether notes are spent |
| `POST /v1/exits` | Forced exit status |
| `POST /v1/claims/ratio` | Claim ratio for a shortfall claim |
| `GET /v1/spot/pools` | Pool list |
| `POST /v1/spot/quote` | A rounded swap estimate, marked indicative |
| `GET /v1/markets` | All markets, with price and funding |
| `GET /v1/markets/:id` | One market |
| `GET /v1/markets/:id/funding?from=&limit=` | A market's funding history |

Paged routes take `from`, a leaf index for records, deposits and leaves or an offset for funding, and `limit`, which goes up to 512. Records and deposits return `nextFrom`, which is `null` once you've read everything. Large integers come back as decimal strings, so parse them as bigints.

Lookups tied to your own secrets, like nullifiers, use `POST` bodies so they never appear in a URL or an access log. Each one takes a JSON array of 32-byte hex strings: up to 256 `nullifiers` for `/v1/nullifiers` and `/v1/exits`, and up to 32 `deltaCommitments` for `/v1/claims/ratio`.

```sh
curl -X POST https://api.rooq.trade/v1/nullifiers \
  -H 'content-type: application/json' \
  -d '{"nullifiers":["0x…32 bytes…"]}'
# {"spent":[false],"syncedBlock":"155832380"}
```

### Spot quotes

`POST /v1/spot/quote` takes a pool ID, an optional second pool for a two-hop route through USDG, the token you pay in and the amount in its base units. Pool IDs and amounts are strings, in decimal or `0x` hex.

```sh
curl -X POST https://api.rooq.trade/v1/spot/quote \
  -H 'content-type: application/json' \
  -d '{"pool":"1","assetIn":"0x7E955252E15c84f5768B83c41a71F9eba181802F","amountIn":"10000000"}'
```

```json
{"pool":"1","secondPool":"0","amountOut":"21970000000000000","priceImpactBps":968,"hops":1,"indicative":true}
```

That's 10 USDG (6 decimals) into the TSLA pool. To route TSLA into AMZN, send `"pool":"1","secondPool":"2"` with TSLA as `assetIn`, and the response will have `"hops":2`. An unknown pool returns `422 UNKNOWN_POOL`.

### Limits and errors

Reads are limited to 600 per minute for each client, claim ratios to 120 and quotes to 30. Each pool also has a quote budget shared by all clients. Errors return a stable reason code, and the body tells you whether a retry can help:

```json
{"statusCode":400,"reasonCode":"INVALID_REQUEST","message":"pool must be a decimal or 0x hex string.","canRetry":false,"requestId":"…"}
```

A rate limit returns `429 RATE_LIMITED` with `canRetry: true`.

## Relayer

The relayer pays gas and submits proofs you've already made. It sees only what's about to become public and can't sign for anyone.

It's served from the same base URL as the read API.

| Route | What it does |
| --- | --- |
| `POST /v1/relay/:action` | Submits a proof. Limited to 60 per minute |
| `GET /v1/jobs/:id` | Status of a submission, by its 32-byte job ID |
| `GET /v1/relayer` | Fee address and minimum fees |

Actions are `lock`, `lockPair`, `spend`, `updatePair`, `closePair`, `requestExit`, `release`, `redeemClaim`, `swap`, `addLiquidity`, `setLiquidityRequest` and `removeLiquidity`.

A job's ID is the hash of its calldata, so retrying the same request is the same job. Job status is `pending`, `confirmed`, `reverted` or `reorged`. The relayer checks that any fee note pays it enough before it submits.

## Contracts

The current testnet deployment is on Robinhood Chain testnet (chain ID 46630), deployment ID `68150201130028574615962385428955034675092974102098788`. `GET /v1/deployment` returns the same values, so check them against it before you sign anything.

| Contract | Address |
| --- | --- |
| Privacy pool | `0x4285fb6228ddE782782086f241f8Aa89fDDFb364` |
| Spot | `0x46Ab17E4ce4065995a726441Ff9385EeE8606309` |
| Markets module | `0x05185D5fF8A4aBec801CCb7e10D03054cD291AB6` |
| Oracle | `0x938218c1637B7A7c587E9d4F4FF370502b233DF0` |
| Registry | `0x23Ab6958c52D39f6a12F1664E33922AfE760d770` |
| Timelock | `0x1dE6B4Fa5a4BdDc3D283eA609Ee4c81E3C785c6E` |
| USDG (collateral) | `0x7E955252E15c84f5768B83c41a71F9eba181802F` |

| Stock token | Address | Spot pool | Perp market |
| --- | --- | --- | --- |
| TSLA | `0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E` | 1 | 1 |
| AMZN | `0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02` | 2 | 2 |
| PLTR | `0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0` | 3 | 3 |
| NFLX | `0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93` | 4 | 4 |
| AMD | `0x71178BAc73cBeb415514eB542a8995b82669778d` | 5 | 5 |

Every spot pool pairs USDG with one stock token and charges a 30 bps fee.

## SDK

`@rooq/private-sdk` is the TypeScript package Rooq's own wallet uses. It builds notes, encrypts records, computes tree paths and makes proofs with UltraHonk.

```ts
import { addressOf, deriveKeys, scanCreated } from "@rooq/private-sdk";

// Keys are derived from one secret seed. Keep it on the client.
const keys = deriveKeys(seed);

// Share this to receive private transfers. It reveals neither key.
const privateAddress = addressOf(keys);

// Find this wallet's notes in events fetched from the chain or the read API.
const notes = scanCreated(keys, deploymentId, createdEvents);
```

| Area | Exports |
| --- | --- |
| Keys | `deriveKeys`, `addressOf`, `ownerTag`, `depositOpening`, `lockAddressKeys` |
| Scanning | `scanCreated` |
| Perps | `lockWitness`, `openPairWitness`, `updateWitness`, `closeWitness`, `exitRequestWitness`, `liquidationOutcome`, `closeOutcome` |
| Spot | `swapWitness`, `lpAddWitness`, `lpSetWitness`, `lpRemoveWitness`, `amountOut` |
| Proving | `Prover` |

`Prover` runs in the browser or in Node.

## Rules for integrators

- Never send a seed, spending key or witness to any server, log or URL.
- Check the deployment ID. Notes from one deployment aren't valid in another.
- Treat a quote as an estimate. The minimum you sign is what binds.
- Treat a submitted proof as unconfirmed until it's included in a block.
- Never fall back to a public transaction if proving fails.

Rooq has not been audited, and everything here runs on testnet.
