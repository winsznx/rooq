# @rooq/private-sdk

Client SDK for Rooq private spot and perps on Robinhood Chain testnet (chain ID 46630). It's the same TypeScript package the Rooq wallet uses to derive keys, build and scan notes, encrypt records, keep the note tree, build circuit witnesses and prove them with UltraHonk.

> Testnet only. Rooq has not been audited. Don't use real funds, and expect breaking changes before 1.0.

## Install

```sh
npm install @rooq/private-sdk
```

ESM only. Works in Node 22+ and modern browsers. Proving with more than one thread needs `SharedArrayBuffer`, which in a browser means cross-origin isolation (COOP and COEP headers).

## Example

This reads public market data and a spot quote from the read API, then builds a spend witness on the client. The note is made up locally so the example runs on its own. A real wallet finds its notes with `scanCreated` and fetches the tree from `/v1/tree/leaves`.

```ts
import {
  addressOf,
  deriveKeys,
  initCrypto,
  marginRequirement,
  MerkleTree,
  noteCommitment,
  noteInner,
  ownerNullifier,
  randomField,
  spendWitness,
} from "@rooq/private-sdk";

const API = "https://api.rooq.trade";
const get = async (path: string) => (await fetch(API + path)).json();

const deployment = await get("/v1/deployment");
const { markets } = await get("/v1/markets");
const m = markets[0];

// Initial margin for 1 unit at the current mark, in USDG base units.
const size = 10n ** 18n;
console.log("margin", marginRequirement(size, BigInt(m.mark), BigInt(m.imrWad), BigInt(m.scale)));

const quote = await (
  await fetch(`${API}/v1/spot/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pool: "1", assetIn: deployment.asset, amountIn: "10000000" }),
  })
).json();
console.log("10 USDG buys", quote.amountOut, "(indicative)");

// Everything below runs locally. Seeds, keys and witnesses never leave the client.
await initCrypto();
const keys = deriveKeys(randomField());
const id = BigInt(deployment.deploymentId);
const asset = BigInt(deployment.asset);

const rho = randomField();
const blind = randomField();
const commitment = noteCommitment(id, asset, 5_000_000n, noteInner(keys.owner, rho, blind));
const tree = new MerkleTree();
const leafIndex = tree.insert(commitment);
const note = { leafIndex, asset, value: 5_000_000n, rho, blind, commitment, nullifier: ownerNullifier(keys.nk, commitment) };

const w = spendWitness({ keys, deployment: id, tree, asset, inputs: [note], outputs: [{ value: 5_000_000n, to: addressOf(keys) }] });
console.log("nullifiers", w.publicInputs.nullifiers);
```

To prove `w.inputs`, load the matching circuit artifact and call `Prover`:

```ts
import { Prover } from "@rooq/private-sdk";

const circuit = await (await fetch("https://rooq.trade/proving/spend.json")).json();
const prover = await Prover.create(circuit);
const proof = await prover.prove(w.inputs);
await prover.destroy();
```

## Circuit artifacts

The package doesn't ship compiled circuits. They're about 4 MB together and must match the verifier contracts of the deployment you prove against, so `Prover.create` takes the compiled circuit as an argument. The current testnet artifacts are served at `https://rooq.trade/proving/<circuit>.json`. Check the deployment ID from `GET /v1/deployment` before you rely on them.

## Entry points

| Import | Contents |
| --- | --- |
| `@rooq/private-sdk` | Keys, notes, encryption, tree, scanning, perps and spot witnesses, outcomes, `Prover` |
| `@rooq/private-sdk/legacy/v1` | Read-only decoders for record version 1, for wallets migrating off a v1 deployment. Nothing there proves |
| `@rooq/private-sdk/admin` | Types shared by Rooq's analytics service and admin area. Public chain data only |

Call `await initCrypto()` once before anything that hashes or derives keys.

## What stays private and what is public

- Deposits and withdrawals are public. Shielding and unshielding show the address, token and amount on chain.
- Inside the pool, transfers, swaps and positions are commitments and encrypted records. Other users and chain observers don't see who traded what.
- The operators and makers that fill and settle trades see the trade terms they handle, such as size, side and price. Treat them as trusted with that information.
- Nullifier, exit and claim lookups go in `POST` bodies, so your own secrets never appear in a URL or access log.

Never send a seed, spending key or witness to any server, log or URL, and never fall back to a public transaction when proving fails.

## Docs

Full API and SDK reference: https://docs.rooq.trade/api-and-sdk

## License

Apache-2.0. See [LICENSE](./LICENSE). This package is licensed separately from the rest of the Rooq repository.
