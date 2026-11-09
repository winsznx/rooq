"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LAST_MARKET_KEY } from "@/components/trade/trade-view";
import { usePrivate } from "@/lib/private/client";
import { findListed, listedMarkets } from "@/lib/private/market-list";

/** Opens the last market used, else the first listed market. */
export default function TradeIndex() {
  const router = useRouter();
  const { view, offline } = usePrivate();
  useEffect(() => {
    if (offline) {
      router.replace("/app/markets");
      return;
    }
    if (!view) return;
    const markets = listedMarkets(view);
    let target: { key: string; mode: string } | null = null;
    try {
      const raw = window.localStorage.getItem(LAST_MARKET_KEY);
      target = raw ? (JSON.parse(raw) as { key: string; mode: string }) : null;
    } catch (error) {
      console.warn("last market unreadable", error);
    }
    const known = target && findListed(markets, target.key) ? target : null;
    const fallback = markets[0];
    if (known) router.replace(`/app/trade/${known.key}?mode=${known.mode === "spot" ? "spot" : "perps"}`);
    else if (fallback) router.replace(`/app/trade/${fallback.key}?mode=${fallback.market ? "perps" : "spot"}`);
    else router.replace("/app/markets");
  }, [view, offline, router]);
  return <p className="empty">Opening your last market.</p>;
}
