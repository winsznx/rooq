/**
 * Robinhood's public Stock Token reference price (https://api.robinhood.com/rhj/prices/{symbol}), as the TEST oracle
 * relays read it. The REST price is the raw underlying-equity bid/ask, so `currentMultiplier` from /rhj/assets is applied
 * to match the onchain feed convention (multiplier included).
 *
 * Shared by the transparent relay (apps/maker), the private relay and the start prices of a private deployment. Every
 * caller is fail-closed: a halted, unreachable or old source returns no price, so nothing is written and the feed ages
 * past its heartbeat instead of publishing a wrong number.
 */
export const TEST_RELAY_SOURCE = "TEST relay of api.robinhood.com/rhj/prices";
export const TEST_RELAY_OPERATOR = "Single-operator TEST relay. It isn't an independent oracle.";

const API = "https://api.robinhood.com/rhj";

interface PriceQuote {
  readonly bid: string;
  readonly ask: string;
  readonly isTradingHalt: boolean;
  readonly generatedAt: string;
}

interface AssetRow {
  readonly tokenSymbol: string;
  readonly currentMultiplier: string;
  readonly status: string;
}

export type ReferenceQuote =
  | { readonly status: "ok"; readonly answer8: bigint; readonly bid: string; readonly ask: string; readonly multiplier: string; readonly sourceAt: string; readonly ageSeconds: number }
  | { readonly status: "halted" | "no_multiplier" | "invalid" }
  | { readonly status: "stale"; readonly ageSeconds: number };

/** "359.4500" -> 35945000000 with 8 decimals, without floating point. */
export function toFeedUnits(decimal: string): bigint {
  const [w = "0", f = ""] = decimal.split(".");
  return BigInt(w) * 10n ** 8n + BigInt((f + "00000000").slice(0, 8));
}

export function applyMultiplier(price8: bigint, multiplier: string): bigint {
  const [w = "1", f = ""] = multiplier.split(".");
  const m18 = BigInt(w) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
  return (price8 * m18) / 10n ** 18n;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export class ReferencePriceSource {
  private multipliers = new Map<string, string>();
  private multipliersAt = 0;

  constructor(
    private readonly maxSourceAgeSeconds: number,
    private readonly multiplierTtlMs: number,
    private readonly fetcher: <T>(url: string) => Promise<T> = fetchJson,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * A split changes the multiplier, so it is reread every few minutes. If the reread fails this throws and nothing is
   * written: a stale multiplier would publish a wrong price, a stale feed only blocks new risk.
   */
  async refreshMultipliers(): Promise<void> {
    if (this.now() - this.multipliersAt < this.multiplierTtlMs && this.multipliers.size > 0) return;
    const { assets } = await this.fetcher<{ assets: AssetRow[] }>(`${API}/assets`);
    this.multipliers = new Map(assets.filter((a) => a.status === "ASSET_STATUS_ACTIVE").map((a) => [a.tokenSymbol, a.currentMultiplier]));
    this.multipliersAt = this.now();
  }

  /** Call refreshMultipliers first. Network and HTTP failures throw; the caller decides how to log one symbol's failure. */
  async quote(symbol: string): Promise<ReferenceQuote> {
    const { quotes } = await this.fetcher<{ quotes: PriceQuote[] }>(`${API}/prices/${symbol}`);
    const q = quotes[0];
    if (!q) throw new Error("empty quote");
    if (q.isTradingHalt) return { status: "halted" };
    const ageSeconds = (this.now() - Date.parse(q.generatedAt)) / 1000;
    if (!(ageSeconds <= this.maxSourceAgeSeconds)) return { status: "stale", ageSeconds };
    const multiplier = this.multipliers.get(symbol);
    if (!multiplier) return { status: "no_multiplier" };
    const bid = toFeedUnits(q.bid);
    const ask = toFeedUnits(q.ask);
    if (bid === 0n || ask < bid) return { status: "invalid" };
    return { status: "ok", answer8: applyMultiplier((bid + ask) / 2n, multiplier), bid: q.bid, ask: q.ask, multiplier, sourceAt: q.generatedAt, ageSeconds };
  }
}
