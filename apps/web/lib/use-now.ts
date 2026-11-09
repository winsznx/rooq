"use client";

import { useEffect, useState } from "react";
import { useBlock } from "wagmi";

/** Current unix time in seconds, ticking once per second. */
export function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/**
 * Chain time in seconds: the latest block timestamp advanced by wall-clock time since it was read.
 * Price ages and quote expiry are measured against chain time because that is what the contracts
 * compare with; a local chain can run hours ahead of the wall clock.
 */
export function useChainNow(): number | null {
  const now = useNow();
  const { data: block } = useBlock({ query: { refetchInterval: 4_000 } });
  const [anchor, setAnchor] = useState<{ chain: number; wall: number } | null>(null);
  const chainTs = block ? Number(block.timestamp) : null;
  const current = chainTs !== null && anchor?.chain !== chainTs ? { chain: chainTs, wall: now } : anchor;
  if (current !== anchor) setAnchor(current);
  if (!current) return null;
  return current.chain + Math.max(0, now - current.wall);
}
