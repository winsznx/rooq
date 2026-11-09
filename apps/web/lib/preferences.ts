"use client";

import { useSyncExternalStore } from "react";

const SLIPPAGE_KEY = "rooq-slippage-bps";
export const DEFAULT_SLIPPAGE_BPS = 50;
export const MAX_SLIPPAGE_BPS = 500;
const listeners = new Set<() => void>();

function read(): number {
  try {
    const v = Number(window.localStorage.getItem(SLIPPAGE_KEY));
    return Number.isInteger(v) && v > 0 && v <= MAX_SLIPPAGE_BPS ? v : DEFAULT_SLIPPAGE_BPS;
  } catch (error) {
    console.warn("preferences unavailable", error);
    return DEFAULT_SLIPPAGE_BPS;
  }
}

/** Slippage is a per-viewer convenience; the contract enforces minimum output either way. */
export function useSlippageBps(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => DEFAULT_SLIPPAGE_BPS,
  );
}

export function setSlippageBps(bps: number): void {
  if (!Number.isInteger(bps) || bps <= 0 || bps > MAX_SLIPPAGE_BPS) throw new RangeError("Slippage must be between 0.01% and 5%");
  window.localStorage.setItem(SLIPPAGE_KEY, String(bps));
  listeners.forEach((l) => l());
}

function createBrowserFlag(key: string) {
  const subscribers = new Set<() => void>();
  const readFlag = (): boolean => {
    try {
      return window.localStorage.getItem(key) === "1";
    } catch (error) {
      console.warn("preferences unavailable", error);
      return false;
    }
  };
  return {
    use: () =>
      useSyncExternalStore(
        (cb) => {
          subscribers.add(cb);
          return () => subscribers.delete(cb);
        },
        readFlag,
        () => false,
      ),
    set: (on: boolean) => {
      try {
        window.localStorage.setItem(key, on ? "1" : "0");
      } catch (error) {
        console.warn("preference not stored", error);
      }
      subscribers.forEach((l) => l());
    },
  };
}

const hideValues = createBrowserFlag("rooq-hide-values");

/** Hides figures on this screen only, for shoulder-surfing. It changes nothing onchain. */
export const useHideValues = hideValues.use;
export const setHideValues = hideValues.set;

const notifyOperations = createBrowserFlag("rooq-notify-operations");

/** Off by default. Turning it on asks the browser for permission first. */
export const useNotifyOperations = notifyOperations.use;
export const setNotifyOperations = notifyOperations.set;

const WATCHLIST_KEY = "rooq-watchlist-v1";
const watchSubscribers = new Set<() => void>();
const NO_WATCHES: readonly string[] = [];
let watchCache: { raw: string | null; keys: readonly string[] } = { raw: null, keys: NO_WATCHES };

function readWatchlist(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(WATCHLIST_KEY);
    if (raw !== watchCache.raw) watchCache = { raw, keys: raw ? (JSON.parse(raw) as string[]) : NO_WATCHES };
  } catch (error) {
    console.warn("watchlist unreadable", error);
  }
  return watchCache.keys;
}

/** Saved market keys, stored in this browser only. */
export function useWatchlist(): readonly string[] {
  return useSyncExternalStore(
    (cb) => {
      watchSubscribers.add(cb);
      return () => watchSubscribers.delete(cb);
    },
    readWatchlist,
    () => NO_WATCHES,
  );
}

export function toggleWatchlist(key: string): void {
  const keys = readWatchlist();
  const next = keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
  try {
    window.localStorage.setItem(WATCHLIST_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn("watchlist not stored", error);
  }
  watchSubscribers.forEach((l) => l());
}
