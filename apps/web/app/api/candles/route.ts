import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { RESOLUTION_CACHE_SECONDS, RESOLUTION_LOOKBACK_SECONDS, isCandleResolution, parseUdfHistory, pythSymbolFor, type CandlesResponse } from "@/lib/pyth/candles";

const PYTH_HISTORY_URL = "https://pyth.dourolabs.app/v1/fixed_rate@200ms/history";
const UPSTREAM_TIMEOUT_MS = 8_000;

function error(status: number, reasonCode: string, message: string): NextResponse {
  return NextResponse.json({ reasonCode, message }, { status, headers: { "cache-control": "no-store" } });
}

/**
 * GET /api/candles?symbol=TSLA&resolution=5. Proxies Pyth Pro history so the API key stays on the server, as Pyth
 * requires. Only the listed tickers and resolutions are accepted; the time window is chosen here, not by the caller.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const key = process.env.PYTH_PRO_API_KEY?.trim();
  if (!key) return error(503, "NOT_CONFIGURED", "Candles aren't configured yet.");

  const ticker = request.nextUrl.searchParams.get("symbol") ?? "";
  const resolution = request.nextUrl.searchParams.get("resolution");
  const symbol = pythSymbolFor(ticker);
  if (!symbol) return error(400, "UNKNOWN_SYMBOL", "No candles for this market.");
  if (!isCandleResolution(resolution)) return error(400, "BAD_RESOLUTION", "Unsupported candle size.");

  const to = Math.floor(Date.now() / 1000);
  const from = to - RESOLUTION_LOOKBACK_SECONDS[resolution];
  const url = new URL(PYTH_HISTORY_URL);
  url.search = new URLSearchParams({ symbol, resolution, from: String(from), to: String(to), split_adjusted: "true" }).toString();

  let body: unknown;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn("pyth_history_failed", { status: res.status, symbol, resolution });
      return error(502, "UPSTREAM_FAILED", "Candles are briefly unavailable.");
    }
    body = await res.json();
  } catch (cause) {
    console.warn("pyth_history_unreachable", { symbol, resolution, name: cause instanceof Error ? cause.name : "unknown" });
    return error(502, "UPSTREAM_FAILED", "Candles are briefly unavailable.");
  }

  let candles;
  try {
    candles = parseUdfHistory(body);
  } catch (cause) {
    console.warn("pyth_history_bad_body", { symbol, resolution, message: cause instanceof Error ? cause.message : "unknown" });
    return error(502, "UPSTREAM_FAILED", "Candles are briefly unavailable.");
  }

  const payload: CandlesResponse = { symbol: ticker, resolution, candles };
  const maxAge = RESOLUTION_CACHE_SECONDS[resolution];
  return NextResponse.json(payload, { headers: { "cache-control": `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 3}` } });
}
