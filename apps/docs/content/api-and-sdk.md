Rooq's services only return public chain data and encrypted records. Your keys and proofs stay on the client. If you build on Rooq, you do the decryption and proving yourself with the SDK.

## Read API

The read API holds no keys and keeps no per-client state. It's a way to fetch public chain data, and you can rebuild everything it serves from the chain yourself. Paths below are relative to its base URL.

| Route | What it returns |
| --- | --- |
| `GET /v1/sync` | How far the service has read the chain |
| `GET /v1/deployment` | Deployment ID, addresses and public keys |
| `GET /v1/records` | Encrypted records, by page |
| `GET /v1/deposits` | Shield events, by page |
| `GET /v1/tree/leaves` | Note tree leaves |
| `GET /v1/tree/path/:index` | A proof path for one leaf |
| `POST /v1/nullifiers` | Whether notes are spent |
| `POST /v1/exits` | Forced exit status |
| `POST /v1/claims/ratio` | Claim ratio for a shortfall claim |
| `GET /v1/spot/pools` | Pool list |
| `POST /v1/spot/quote` | A rounded swap estimate, marked indicative |
| `GET /v1/markets` | All markets, with price and funding |
| `GET /v1/markets/:id` | One market |
| `GET /v1/markets/:id/funding` | A market's funding history |

Lookups tied to your own secrets, like nullifiers, use `POST` bodies so they never appear in a URL or an access log.

Reads are limited to 600 per minute for each client, and quotes to 30. Errors return a stable reason code.

## Relayer

The relayer pays gas and submits proofs you've already made. It sees only what's about to become public and can't sign for anyone.

| Route | What it does |
| --- | --- |
| `POST /v1/relay/:action` | Submits a proof. Limited to 60 per minute |
| `GET /v1/jobs/:id` | Status of a submission |
| `GET /v1/relayer` | Fee address and minimum fees |

Actions are `lock`, `spend`, `updatePair`, `closePair`, `requestExit`, `release`, `redeemClaim`, `swap`, `addLiquidity`, `setLiquidityRequest` and `removeLiquidity`.

A job's ID is the hash of its calldata, so retrying the same request is the same job. Job status is `pending`, `confirmed`, `reverted` or `reorged`. The relayer checks that any fee note pays it enough before it submits.

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
