"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { pythSymbolFor, type CandleResolution, type CandlesResponse } from "./candles";

const REFETCH_MS: Record<CandleResolution, number> = { "1": 15_000, "5": 30_000, "15": 60_000, "60": 120_000, D: 600_000 };

class CandlesUnavailable extends Error {
  override readonly name = "CandlesUnavailable";
  constructor(readonly status: number, readonly reasonCode: string | null) {
    super(`Candles unavailable (${status}${reasonCode ? ` ${reasonCode}` : ""})`);
  }
}

async function fetchCandles(symbol: string, resolution: CandleResolution, signal: AbortSignal): Promise<CandlesResponse | null> {
  const res = await fetch(`/api/candles?${new URLSearchParams({ symbol, resolution })}`, { signal, headers: { accept: "application/json" } });
  if (res.ok) return (await res.json()) as CandlesResponse;
  const body = (await res.json().catch(() => null)) as { reasonCode?: string } | null;
  // Not configured is a steady state, not a failure: the chart keeps its oracle line.
  if (res.status === 503 && body?.reasonCode === "NOT_CONFIGURED") return null;
  throw new CandlesUnavailable(res.status, body?.reasonCode ?? null);
}

/** Pyth candles for a listed ticker. Resolves to null when the market has no Pyth feed or candles aren't configured. */
export function useCandles(ticker: string, resolution: CandleResolution): UseQueryResult<CandlesResponse | null> {
  const supported = pythSymbolFor(ticker) !== null;
  return useQuery({
    queryKey: ["candles", ticker, resolution],
    queryFn: ({ signal }) => fetchCandles(ticker, resolution, signal),
    enabled: supported,
    refetchInterval: REFETCH_MS[resolution],
    retry: (count, err) => count < 2 && !(err instanceof CandlesUnavailable && err.status < 500),
    staleTime: REFETCH_MS[resolution] / 2,
  });
}
