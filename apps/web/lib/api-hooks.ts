"use client";

import { useQuery } from "@tanstack/react-query";
import type { ActivityResponse, ChartResponse, HealthResponse, TradeRow } from "@rooq/sdk";
import { apiGet } from "./api";

export function useApiHealth() {
  return useQuery({ queryKey: ["api", "health"], queryFn: ({ signal }) => apiGet<HealthResponse>("/health", signal), refetchInterval: 10_000, retry: 0 });
}

export function useChart(marketId: string | undefined, interval: ChartResponse["interval"]) {
  return useQuery({
    queryKey: ["api", "chart", marketId, interval],
    enabled: Boolean(marketId),
    queryFn: ({ signal }) => apiGet<ChartResponse>(`/markets/${marketId}/chart?interval=${interval}`, signal),
    refetchInterval: 15_000,
    retry: 0,
  });
}

export function useTrades(marketId: string | undefined) {
  return useQuery({
    queryKey: ["api", "trades", marketId],
    enabled: Boolean(marketId),
    queryFn: ({ signal }) => apiGet<{ trades: TradeRow[]; nextCursor: string | null }>(`/markets/${marketId}/trades`, signal),
    refetchInterval: 8_000,
    retry: 0,
  });
}

export function useActivity(wallet: string | undefined) {
  return useQuery({
    queryKey: ["api", "activity", wallet],
    enabled: Boolean(wallet),
    queryFn: ({ signal }) => apiGet<ActivityResponse>(`/account/${wallet}/activity`, signal),
    refetchInterval: 8_000,
    retry: 0,
  });
}
