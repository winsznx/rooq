/**
 * Pyth Pro candles for the underlying US equities. Pyth has no feed for Robinhood Stock Tokens, so the chart shows the
 * underlying share price; trades, funding and liquidation always use Rooq's own oracle, drawn as a line on top.
 */

export const PYTH_EQUITY_SYMBOLS: Readonly<Record<string, string>> = {
  TSLA: "Equity.US.TSLA/USD",
  AMZN: "Equity.US.AMZN/USD",
  PLTR: "Equity.US.PLTR/USD",
  NFLX: "Equity.US.NFLX/USD",
  AMD: "Equity.US.AMD/USD",
};

export const CANDLE_RESOLUTIONS = ["1", "5", "15", "60", "D"] as const;
export type CandleResolution = (typeof CANDLE_RESOLUTIONS)[number];

export const RESOLUTION_LABEL: Record<CandleResolution, string> = { "1": "1m", "5": "5m", "15": "15m", "60": "1h", D: "1D" };

/** Seconds per candle, used to spot a closed session and to size the lookback. */
export const RESOLUTION_SECONDS: Record<CandleResolution, number> = { "1": 60, "5": 300, "15": 900, "60": 3_600, D: 86_400 };

/** How far back each resolution loads: enough candles to read a trend without a heavy request. */
export const RESOLUTION_LOOKBACK_SECONDS: Record<CandleResolution, number> = {
  "1": 86_400,
  "5": 5 * 86_400,
  "15": 14 * 86_400,
  "60": 60 * 86_400,
  D: 730 * 86_400,
};

/** How long a response may be reused: the newest candle changes often on short resolutions, rarely on daily. */
export const RESOLUTION_CACHE_SECONDS: Record<CandleResolution, number> = { "1": 10, "5": 20, "15": 30, "60": 60, D: 300 };

export interface Candle {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface CandlesResponse {
  readonly symbol: string;
  readonly resolution: CandleResolution;
  readonly candles: readonly Candle[];
}

export function isCandleResolution(value: string | null): value is CandleResolution {
  return value !== null && (CANDLE_RESOLUTIONS as readonly string[]).includes(value);
}

export function pythSymbolFor(ticker: string): string | null {
  return PYTH_EQUITY_SYMBOLS[ticker] ?? null;
}

/** A session is treated as closed when the newest candle is older than three candles. */
export function isSessionClosed(candles: readonly Candle[], resolution: CandleResolution, nowSeconds: number): boolean {
  if (resolution === "D") return false;
  const last = candles.at(-1);
  if (!last) return false;
  return nowSeconds - last.time > RESOLUTION_SECONDS[resolution] * 3;
}

interface UdfHistory {
  readonly s: string;
  readonly t?: readonly number[];
  readonly o?: readonly number[];
  readonly h?: readonly number[];
  readonly l?: readonly number[];
  readonly c?: readonly number[];
}

function isUdfHistory(body: unknown): body is UdfHistory {
  return typeof body === "object" && body !== null && "s" in body && typeof (body as { s: unknown }).s === "string";
}

/** Turns a TradingView UDF history body into candles. "no_data" is an empty range, not an error. */
export function parseUdfHistory(body: unknown): Candle[] {
  if (!isUdfHistory(body)) throw new Error("Pyth history response has an unexpected shape");
  if (body.s === "no_data") return [];
  if (body.s !== "ok") throw new Error(`Pyth history status ${body.s}`);
  const { t = [], o = [], h = [], l = [], c = [] } = body;
  const n = Math.min(t.length, o.length, h.length, l.length, c.length);
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const candle = { time: t[i]!, open: o[i]!, high: h[i]!, low: l[i]!, close: c[i]! };
    if (Object.values(candle).every(Number.isFinite)) out.push(candle);
  }
  return out.sort((a, b) => a.time - b.time);
}
