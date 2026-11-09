/**
 * Rooq maker quote service.
 *
 * Signs short-lived, taker-bound EIP-712 quotes for one maker account. It holds only the delegated
 * quote-signer key (QUOTE_SIGNER_PRIVATE_KEY), which the ClearingHouse accepts for this maker's quotes
 * but which can never deposit, withdraw or move collateral. Every quote is re-checked onchain at fill:
 * this service cannot force a fill or exceed the maker's committed backing.
 */
import { getAddress, hashTypedData, isAddress, isHex, type Address, type Hex } from "viem";
import {
  QUOTE_TYPES,
  absBig,
  clearingHouseAbi,
  marginVaultAbi,
  marginRequirement,
  marketRegistryAbi,
  oracleAdapterAbi,
  quoteDomain,
  scaleFor,
  type MakerQuote,
} from "@rooq/sdk";
import { loadChain, log, requireEnv, walletFor } from "./chain";

const ctx = await loadChain();
const { account: signer } = walletFor(ctx, "QUOTE_SIGNER_PRIVATE_KEY");
const maker = getAddress(requireEnv("MAKER_ADDRESS"));
const dep = ctx.deployment;
const scale = scaleFor(dep.collateralDecimals);
const PORT = Number(process.env.MAKER_PORT ?? 8701);
const TTL_SECONDS = BigInt(process.env.QUOTE_TTL_SECONDS ?? 20);
const SPREAD_BPS = BigInt(process.env.QUOTE_SPREAD_BPS ?? 10);
/** Keep a buffer of committed backing unquoted so concurrent quotes cannot all be filled at once. */
const CAPACITY_USE_BPS = BigInt(process.env.QUOTE_CAPACITY_USE_BPS ?? 8_000);
const ALLOWED_ORIGINS = (process.env.ROOQ_ALLOWED_ORIGINS ?? "http://localhost:3200,http://127.0.0.1:3200").split(",");
let quotingEnabled = process.env.QUOTING_DISABLED !== "1";
let nonceCounter = 0n;

const PERP_ACTIVE = 2;
const PERP_CLOSE_ONLY = 3;

interface QuoteLog {
  readonly quoteHash?: Hex;
  readonly marketId: Hex;
  readonly taker: Address;
  readonly size: string;
  readonly price: string;
  readonly nonce: string;
  readonly deadline: string;
  readonly issuedAt: string;
}
const recent: QuoteLog[] = [];
const hits = new Map<string, number[]>();
/** Behind one reverse proxy, the rightmost x-forwarded-for entry is the address that proxy saw. */
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;

/**
 * Maker margin promised by live quotes, one entry per (market, taker): a taker's newer quote replaces the
 * older reservation. Without this, quotes to many takers could each claim the same committed backing. A
 * reservation lasts until the quote's deadline; a filled quote is briefly counted twice (it also lowered
 * the commitment), which errs toward refusing rather than over-quoting. The ClearingHouse still enforces
 * the real limit at fill time.
 */
const reservations = new Map<string, { readonly marketId: Hex; readonly amount: bigint; readonly deadline: bigint }>();

function reservedFor(marketId: Hex, chainNow: bigint, exceptTaker: Address): bigint {
  let total = 0n;
  for (const [key, r] of reservations) {
    if (r.deadline <= chainNow) reservations.delete(key);
    else if (r.marketId === marketId && key !== reservationKey(marketId, exceptTaker)) total += r.amount;
  }
  return total;
}

function reservationKey(marketId: Hex, taker: Address): string {
  return `${marketId}:${taker}`;
}

function clientKey(req: Request, peer: string | undefined): string {
  if (TRUST_PROXY) {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  return peer ?? "unknown";
}

function json(body: unknown, status = 200, origin?: string | null): Response {
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "origin";
  }
  return new Response(
    JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    { status, headers },
  );
}

function refuse(reasonCode: string, message: string, status: number, origin: string | null, details?: unknown): Response {
  return json({ reasonCode, message, canRetry: status < 500, requestId: crypto.randomUUID(), details }, status, origin);
}

function rateLimited(key: string): boolean {
  const now = Date.now();
  const window = (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  window.push(now);
  hits.set(key, window);
  return window.length > RATE_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, times] of hits) if (times.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(key);
}, RATE_WINDOW_MS).unref();

async function readMarket(marketId: Hex) {
  return ctx.publicClient.readContract({
    address: dep.marketRegistry,
    abi: marketRegistryAbi,
    functionName: "getMarket",
    args: [marketId],
  });
}

async function quoteFor(marketId: Hex, taker: Address, size: bigint, origin: string | null): Promise<Response> {
  if (!quotingEnabled) return refuse("MAKER_CAPACITY_EXHAUSTED", "Quoting is paused by the maker.", 503, origin);
  if (size === 0n) return refuse("INTERNAL", "Size must be non-zero.", 400, origin);

  const market = await readMarket(marketId);
  const [mark, updatedAt, fresh] = await ctx.publicClient.readContract({
    address: dep.oracleAdapter,
    abi: oracleAdapterAbi,
    functionName: "getPrice",
    args: [market.feedId],
  });
  const pair = await ctx.publicClient.readContract({
    address: dep.clearingHouse,
    abi: clearingHouseAbi,
    functionName: "getPair",
    args: [marketId, taker],
  });

  const increasing = pair.size === 0n || (pair.size > 0n) === (size > 0n);
  if (pair.size !== 0n && getAddress(pair.maker) !== maker) {
    return refuse("MAKER_CAPACITY_EXHAUSTED", "This position is held with a different maker.", 409, origin);
  }
  if (!increasing && absBig(size) > absBig(pair.size)) {
    return refuse("INTERNAL", "Close the position before opening the other side.", 400, origin);
  }
  if (increasing && market.perpStatus !== PERP_ACTIVE) {
    return refuse("MARKET_CLOSE_ONLY", "This market is not open for new positions.", 409, origin, { status: market.perpStatus });
  }
  if (!increasing && market.perpStatus !== PERP_ACTIVE && market.perpStatus !== PERP_CLOSE_ONLY) {
    return refuse("MARKET_PAUSED", "This market is paused.", 409, origin, { status: market.perpStatus });
  }
  if (!fresh) {
    return refuse("PRICE_STALE", "Price updates are delayed.", 409, origin, { updatedAt: updatedAt.toString() });
  }

  const block = await ctx.publicClient.getBlock();
  let reserve = 0n;
  if (increasing) {
    const commit = await ctx.publicClient.readContract({
      address: dep.marginVault,
      abi: marginVaultAbi,
      functionName: "balanceOf",
      args: [
        await ctx.publicClient.readContract({
          address: dep.clearingHouse,
          abi: clearingHouseAbi,
          functionName: "commitDomain",
          args: [marketId],
        }),
        maker,
      ],
    });
    const newAbs = absBig(pair.size + size);
    const need = marginRequirement(newAbs, mark, market.risk.imrWad, scale) - pair.makerMargin;
    const reserved = reservedFor(marketId, block.timestamp, taker);
    const capped = (commit * CAPACITY_USE_BPS) / 10_000n;
    const usable = capped > reserved ? capped - reserved : 0n;
    if (need > usable) {
      const perUnit = marginRequirement(10n ** 18n, mark, market.risk.imrWad, scale);
      const available = perUnit === 0n ? 0n : ((usable + pair.makerMargin) * 10n ** 18n) / perUnit - absBig(pair.size);
      return refuse("MAKER_CAPACITY_EXHAUSTED", "No executable quote is available right now.", 409, origin, {
        availableBase: (available > 0n ? available : 0n).toString(),
      });
    }
    reserve = need > 0n ? need : 0n;
  }

  const spread = (mark * SPREAD_BPS) / 10_000n;
  const price = size > 0n ? mark + spread : mark - spread;
  nonceCounter += 1n;
  const quote: MakerQuote = {
    marketId,
    maker,
    taker,
    size,
    price,
    minFill: 0n,
    nonce: BigInt(Date.now()) * 1_000_000n + nonceCounter,
    deadline: block.timestamp + TTL_SECONDS,
    policyVersion: market.risk.version,
  };
  const typed = {
    domain: quoteDomain(dep.chainId, dep.clearingHouse),
    types: QUOTE_TYPES,
    primaryType: "Quote",
    message: quote,
  } as const;
  const signature = await signer.signTypedData(typed);
  if (reserve > 0n) reservations.set(reservationKey(marketId, taker), { marketId, amount: reserve, deadline: quote.deadline });
  else reservations.delete(reservationKey(marketId, taker));
  const quoteHash = hashTypedData(typed);
  recent.unshift({
    quoteHash,
    marketId,
    taker,
    size: size.toString(),
    price: price.toString(),
    nonce: quote.nonce.toString(),
    deadline: quote.deadline.toString(),
    issuedAt: new Date().toISOString(),
  });
  recent.length = Math.min(recent.length, 200);
  log("maker", "quote_issued", { marketId, taker, size, price, mark, nonce: quote.nonce, quoteHash });
  return json(
    {
      quote,
      signature,
      signer: signer.address,
      quoteHash,
      mark,
      markUpdatedAt: updatedAt,
      spreadBps: SPREAD_BPS,
      expiresAt: quote.deadline,
      chainTime: block.timestamp,
      blockNumber: block.number,
      authoritative: false,
      note: "Indicative until the ClearingHouse verifies it onchain.",
    },
    200,
    origin,
  );
}

Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    const origin = req.headers.get("origin");
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers:
          origin && ALLOWED_ORIGINS.includes(origin)
            ? {
                "access-control-allow-origin": origin,
                "access-control-allow-methods": "GET,POST",
                "access-control-allow-headers": "content-type",
              }
            : {},
      });
    }
    try {
      if (url.pathname === "/health") {
        const block = await ctx.publicClient.getBlockNumber();
        return json(
          { status: quotingEnabled ? "quoting" : "paused", maker, signer: signer.address, chainId: dep.chainId, block },
          200,
          origin,
        );
      }
      if (url.pathname === "/quotes/recent") return json({ quotes: recent.slice(0, 50) }, 200, origin);
      if (url.pathname === "/quote" && req.method === "POST") {
        const client = clientKey(req, server.requestIP(req)?.address);
        if (rateLimited(client)) return refuse("INTERNAL", "Too many quote requests. Wait a moment.", 429, origin);
        const body = (await req.json()) as { marketId?: string; taker?: string; size?: string };
        if (!body.marketId || !isHex(body.marketId) || body.marketId.length !== 66) {
          return refuse("INTERNAL", "marketId must be a 32-byte hex string.", 400, origin);
        }
        if (!body.taker || !isAddress(body.taker)) return refuse("INTERNAL", "taker must be an address.", 400, origin);
        if (!body.size || !/^-?\d+$/.test(body.size)) return refuse("INTERNAL", "size must be an integer string.", 400, origin);
        return await quoteFor(body.marketId as Hex, getAddress(body.taker), BigInt(body.size), origin);
      }
      if (url.pathname === "/admin/quoting" && req.method === "POST") {
        if (req.headers.get("x-admin-token") !== process.env.MAKER_ADMIN_TOKEN || !process.env.MAKER_ADMIN_TOKEN) {
          return refuse("INTERNAL", "Not authorised.", 403, origin);
        }
        const body = (await req.json()) as { enabled?: boolean };
        quotingEnabled = body.enabled === true;
        log("maker", "quoting_toggled", { enabled: quotingEnabled });
        return json({ enabled: quotingEnabled }, 200, origin);
      }
      return refuse("INTERNAL", "Not found.", 404, origin);
    } catch (error) {
      const requestId = crypto.randomUUID();
      log("maker", "error", { requestId, error: error instanceof Error ? error.message : String(error) });
      return json({ reasonCode: "INTERNAL", message: "Quote service error.", canRetry: true, requestId }, 500, origin);
    }
  },
});

log("maker", "listening", { port: PORT, maker, signer: signer.address, env: ctx.env, chainId: dep.chainId });
