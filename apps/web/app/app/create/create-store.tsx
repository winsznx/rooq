"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Address, Hex } from "viem";

export interface TokenDraft {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

/**
 * Wizard draft for C01 to C07. Amounts never go into the URL and nothing is signed until review.
 */
export interface CreateDraft {
  token: TokenDraft | null;
  poolFeeBps: 5 | 25 | 100;
  seedBaseText: string;
  seedQuoteText: string;
  perps: boolean;
  feedId: Hex | null;
  tierId: number;
  maxOiUsdText: string;
  plannedBackingText: string;
  bondText: string;
  createdMarketId: Hex | null;
}

const INITIAL: CreateDraft = {
  token: null,
  poolFeeBps: 25,
  seedBaseText: "",
  seedQuoteText: "",
  perps: true,
  feedId: null,
  tierId: 4,
  maxOiUsdText: "",
  plannedBackingText: "",
  bondText: "",
  createdMarketId: null,
};

interface CreateStore {
  readonly draft: CreateDraft;
  readonly update: (patch: Partial<CreateDraft>) => void;
  readonly reset: () => void;
}

const STORAGE_KEY = "rooq-create-draft-v1";
const listeners = new Set<() => void>();
let cache: CreateDraft | null = null;

function read(): CreateDraft {
  if (cache === null) {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      cache = raw ? { ...INITIAL, ...(JSON.parse(raw) as Partial<CreateDraft>) } : INITIAL;
    } catch (error) {
      console.warn("rooq: create draft unreadable", error);
      cache = INITIAL;
    }
  }
  return cache;
}

function write(next: CreateDraft) {
  cache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn("rooq: create draft not stored", error);
  }
  listeners.forEach((l) => l());
}

const Ctx = createContext<CreateStore | null>(null);

/** Keeps the launch draft across navigation and reload. Only form inputs are stored; nothing is signed here. */
export function CreateDraftProvider({ children }: { children: ReactNode }) {
  const draft = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => INITIAL,
  );
  const update = useCallback((patch: Partial<CreateDraft>) => write({ ...read(), ...patch }), []);
  const reset = useCallback(() => write(INITIAL), []);
  const store = useMemo<CreateStore>(() => ({ draft, update, reset }), [draft, update, reset]);
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useCreateDraft(): CreateStore {
  const store = useContext(Ctx);
  if (!store) throw new Error("useCreateDraft outside CreateDraftProvider");
  return store;
}
