/**
 * Serves only public chain data to wallets (ADR-P01, PRIV-01): ciphertexts, commitments, roots and Merkle paths, spent
 * status, market parameters and funding. It holds no keys, decrypts nothing and keeps no per-client state. Lookups
 * tied to a wallet's own secrets go in POST bodies, so a nullifier never appears in a URL or an access log.
 */
import { intEnv, PORTS } from "../lib/config";
import { json, fromParam, limitParam, readJson, type Route } from "../lib/http";
import { badRequest, ServiceError } from "../lib/errors";
import type { ChainContext } from "../lib/chain";
import { runService, type ServiceContext } from "../lib/service";
import { toHex32 } from "@rooq/private-sdk";
import { PublicIndex } from "../lib/public-index";
import type { Hex } from "viem";

const PAGE_LIMIT = 512;
/** Market views read the chain; every visitor polls them, so one read serves everyone for this long. */
const MARKETS_CACHE_MS = 2_000;
const PUBLIC_EVENTS_LIMIT = 5_000;
const BATCH_LIMIT = 256;
const READ_PER_MINUTE = 600;
const QUOTE_PER_MINUTE = Number(process.env.SPOT_QUOTE_PER_MINUTE ?? 30);
const quoteUrls = (process.env.SPOT_QUOTE_URLS ?? `http://127.0.0.1:${PORTS.coordinator},http://127.0.0.1:${PORTS.riskA},http://127.0.0.1:${PORTS.riskB}`).split(",").map((u) => u.trim().replace(/\/+$/, "")).filter((u) => u !== "");

function hex32List(body: Record<string, unknown>, key: string): Hex[] {
  const list = body[key];
  if (!Array.isArray(list) || list.length === 0 || list.length > BATCH_LIMIT) throw badRequest(`${key} must be an array of 1 to ${BATCH_LIMIT} entries.`);
  return list.map((v, i) => {
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw badRequest(`${key}[${i}] must be a 32-byte hex string.`);
    return v.toLowerCase() as Hex;
  });
}

async function marketView(chain: ChainContext, ledgerEpochs: number, id: bigint): Promise<unknown> {
  const m = chain.market(id);
  if (!m) return null;
  const [funding, price, count, policy] = await Promise.all([chain.funding(id), chain.price(m), chain.oiDeltaCount(id), chain.marketPolicy(id)]);
  return {
    market: id, asset: m.asset, feedId: m.feedId, scale: m.scale, imrWad: m.imrWad, mmrWad: m.mmrWad, penaltyBps: m.penaltyBps, maxFundingPerHourWad: m.maxFundingPerHourWad,
    takerFeeBps: m.takerFeeBps, maxOiUsdWad: m.maxOiUsdWad, maxPairSize: m.maxPairSize,
    funding: { index: funding.index, lastEpoch: funding.lastEpoch, head: toHex32(funding.head), consumed: funding.consumed, epochs: ledgerEpochs },
    bond: policy.bond,
    closeOnly: policy.closeOnly,
    oiDeltaCount: count,
    oiPending: (count - funding.consumed) * m.maxPairSize,
    mark: price.fresh ? price.price : 0n,
    markFresh: price.fresh,
    markUpdatedAt: price.updatedAt,
  };
}

function buildRoutes(ctx: ServiceContext, index: PublicIndex): Route[] {
  const { chain, ledger } = ctx;
  let marketsCache: { at: number; body: unknown } | null = null;
  const marketsBody = async (): Promise<unknown> => {
    if (marketsCache && Date.now() - marketsCache.at < MARKETS_CACHE_MS) return marketsCache.body;
    const body = { markets: await Promise.all(chain.markets.map((m) => marketView(chain, ledger.funding.filter((e) => e.market === m.id).length, m.id))) };
    marketsCache = { at: Date.now(), body };
    return body;
  };
  const after = <T extends { block: bigint }>(rows: readonly T[], from: bigint): T[] => {
    let i = rows.length;
    while (i > 0 && rows[i - 1]!.block >= from) i--;
    return rows.slice(i, i + PUBLIC_EVENTS_LIMIT);
  };
  const page = <T extends { leafIndex: number }>(rows: readonly T[], from: number, limit: number, view: (row: T) => unknown): unknown => {
    let i = rows.findIndex((r) => r.leafIndex >= from);
    if (i < 0) i = rows.length;
    const items = rows.slice(i, i + limit);
    return { items: items.map(view), nextFrom: items.length === limit ? items[items.length - 1]!.leafIndex + 1 : null, syncedBlock: ledger.syncedBlock };
  };
  const syncView = (): Record<string, unknown> => ({
    syncedBlock: ledger.syncedBlock, head: ledger.head, lagBlocks: ledger.syncedBlock === null ? null : ledger.head - ledger.syncedBlock,
    processed: ledger.processed, queueLength: ledger.queueLength, root: toHex32(ledger.root), rootSeq: ledger.rootSeq, reorgs: ledger.reorgs,
  });
  return [
    { method: "GET", pattern: "/v1/sync", perMinute: READ_PER_MINUTE, handler: () => json(syncView()) },
    {
      // Everything a page needs that anyone can read on chain, after block `from`, in one response. `pricesSince` is a unix time.
      method: "GET", pattern: "/v1/public", perMinute: READ_PER_MINUTE,
      handler: ({ url }) => {
        const fromRaw = url.searchParams.get("from") ?? "0";
        const sinceRaw = url.searchParams.get("pricesSince") ?? "0";
        if (!/^\d{1,12}$/.test(fromRaw) || !/^\d{1,12}$/.test(sinceRaw)) throw badRequest("from and pricesSince must be integers.");
        const from = BigInt(fromRaw);
        const since = Number(sinceRaw);
        const spent = after(ledger.spent, from);
        const capped = spent.length === PUBLIC_EVENTS_LIMIT;
        return json({
          head: ledger.head, headTime: index.headTime, syncedBlock: ledger.syncedBlock, reorgs: ledger.reorgs,
          nextFrom: capped ? spent.at(-1)!.block : ledger.syncedBlock === null ? from : ledger.syncedBlock + 1n,
          tokens: index.tokens,
          spent: spent.map((e) => ({ nullifier: e.nullifier, block: e.block, tx: e.tx })),
          exits: after(ledger.exits, from).map((e) => ({ nullifier: e.nullifier, matureAt: e.matureAt, block: e.block })),
          ends: after(ledger.ends, from).map((e) => ({ nullifier: e.nullifier, kind: e.kind, market: e.market, mark: e.mark, mode: e.mode, block: e.block, tx: e.tx })),
          unshields: after(ledger.unshields, from).map((e) => ({ asset: e.asset, recipient: e.recipient, amount: e.amount, block: e.block, tx: e.tx })),
          prices: Object.fromEntries(chain.markets.map((m) => [m.id.toString(), index.prices(m.id, since)])),
        });
      },
    },
    { method: "GET", pattern: "/v1/deployment", perMinute: READ_PER_MINUTE, handler: () => json(chain.deploymentView()) },
    {
      method: "GET", pattern: "/v1/records", perMinute: READ_PER_MINUTE,
      handler: ({ url }) => json(page(ledger.records, fromParam(url), limitParam(url, 128, PAGE_LIMIT), (r) => ({ leafIndex: r.leafIndex, kind: r.kind, commitment: toHex32(r.commitment), ciphertext: r.ciphertext.map(toHex32), block: r.block }))),
    },
    {
      method: "GET", pattern: "/v1/deposits", perMinute: READ_PER_MINUTE,
      handler: ({ url }) => json(page(ledger.deposits, fromParam(url), limitParam(url, 128, PAGE_LIMIT), (d) => ({ leafIndex: d.leafIndex, asset: toHex32(d.asset), amount: d.amount, inner: toHex32(d.inner), block: d.block }))),
    },
    {
      // Paging the leaves lets a wallet build its own tree, so the server never learns which leaf the wallet cares about.
      method: "GET", pattern: "/v1/tree/leaves", perMinute: READ_PER_MINUTE,
      handler: ({ url }) => {
        const from = fromParam(url);
        const limit = limitParam(url, 256, PAGE_LIMIT);
        const end = Math.min(from + limit, ledger.processed);
        const leaves: Hex[] = [];
        for (let i = from; i < end; i++) leaves.push(toHex32(ledger.tree.leaf(i) ?? 0n));
        return json({ from, leaves, processed: ledger.processed, root: toHex32(ledger.root), syncedBlock: ledger.syncedBlock });
      },
    },
    {
      method: "GET", pattern: "/v1/tree/path/:index", perMinute: READ_PER_MINUTE,
      handler: ({ params }) => {
        const raw = params.index ?? "";
        if (!/^\d{1,12}$/.test(raw) || Number(raw) >= ledger.processed) throw badRequest("index must be a processed leaf index.");
        return json({ index: Number(raw), path: ledger.tree.path(Number(raw)).map(toHex32), root: toHex32(ledger.root) });
      },
    },
    {
      method: "POST", pattern: "/v1/nullifiers", perMinute: READ_PER_MINUTE,
      handler: async ({ req }) => {
        const nfs = hex32List(await readJson(req, 64 * 1024), "nullifiers");
        return json({ spent: nfs.map((nf) => ledger.consumption(nf) !== undefined), syncedBlock: ledger.syncedBlock });
      },
    },
    {
      method: "POST", pattern: "/v1/exits", perMinute: READ_PER_MINUTE,
      handler: async ({ req }) => {
        const nfs = hex32List(await readJson(req, 64 * 1024), "nullifiers");
        return json({ exits: nfs.map((nf) => { const e = ledger.exits.find((x) => x.nullifier === nf); return e ? { matureAt: e.matureAt } : null; }), syncedBlock: ledger.syncedBlock });
      },
    },
    {
      method: "POST", pattern: "/v1/claims/ratio", perMinute: READ_PER_MINUTE,
      handler: async ({ req }) => {
        const deltas = hex32List(await readJson(req, 64 * 1024), "deltaCommitments");
        const ratios = await Promise.all(deltas.map((d) => chain.read<bigint>("foldedRatioPlusOne", [d])));
        return json({ ratios: ratios.map((r) => (r === 0n ? null : r - 1n)) });
      },
    },
    {
      method: "GET", pattern: "/v1/spot/pools", perMinute: READ_PER_MINUTE,
      handler: async () => {
        const pools = await Promise.all(chain.spotPools.map(async (p) => {
          const head = await chain.spotHead(p.id);
          return { id: p.id, token0: toHex32(p.token0), token1: toHex32(p.token1), feeBps: p.feeBps, seeded: head !== 0n, head: toHex32(head), updates: ledger.spotUpdates.filter((u) => u.pool === p.id).length };
        }));
        return json({ spot: chain.spot, pools, syncedBlock: ledger.syncedBlock });
      },
    },
    {
      // The read API holds no key, so the quote comes from a service that does. Coordinator first, then the risk workers (REC-06).
      method: "POST", pattern: "/v1/spot/quote", perMinute: QUOTE_PER_MINUTE,
      handler: async ({ req }) => {
        const body = await req.text();
        if (body.length > 4_096) throw new ServiceError(413, "BODY_TOO_LARGE", "Request body is too large.", false);
        for (const base of quoteUrls) {
          const res = await fetch(`${base}/v1/spot/quote`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(3_000) }).catch(() => null);
          if (res && res.status < 500) return new Response(res.body, { status: res.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
        }
        throw new ServiceError(503, "QUOTE_UNAVAILABLE", "No pricing service can answer right now.", true);
      },
    },
    { method: "GET", pattern: "/v1/markets", perMinute: READ_PER_MINUTE, handler: async () => json(await marketsBody()) },
    {
      method: "GET", pattern: "/v1/markets/:id", perMinute: READ_PER_MINUTE,
      handler: async ({ params }) => {
        if (!/^\d{1,4}$/.test(params.id ?? "")) throw badRequest("market id must be an integer.");
        const view = await marketView(chain, ledger.funding.filter((e) => e.market === BigInt(params.id ?? "0")).length, BigInt(params.id ?? "0"));
        return view === null ? json({ reasonCode: "UNKNOWN_MARKET", message: "Unknown market." }, 404) : json(view);
      },
    },
    {
      method: "GET", pattern: "/v1/markets/:id/funding", perMinute: READ_PER_MINUTE,
      handler: ({ params, url }) => {
        if (!/^\d{1,4}$/.test(params.id ?? "")) throw badRequest("market id must be an integer.");
        const market = BigInt(params.id ?? "0");
        const events = ledger.funding.filter((e) => e.market === market);
        const items = events.slice(fromParam(url), fromParam(url) + limitParam(url, 256, PAGE_LIMIT));
        return json({ market, total: events.length, items: items.map((e) => ({ index: e.index, asOf: e.asOf, dt: e.dt, mark: e.mark, head: toHex32(e.head), consumed: e.consumed, block: e.block, ciphertext: e.ciphertext.map(toHex32) })) });
      },
    },
  ];
}

await runService({
  name: "read-api",
  port: intEnv(process.env, "PORT", PORTS.readApi, 1),
  init(ctx) {
    ctx.liveness.details = {};
    const index = new PublicIndex(ctx.chain, ctx.log);
    return {
      routes: buildRoutes(ctx, index),
      async tick() {
        await index.refresh(ctx.ledger.head);
        ctx.liveness.backlog = { blocksBehind: ctx.ledger.syncedBlock === null ? 0 : Number(ctx.ledger.head - ctx.ledger.syncedBlock) };
      },
    };
  },
});
