"use client";

import { useSyncExternalStore } from "react";
import type { Hex } from "viem";
import { setPrivateOperations } from "@/lib/operations";
import type { AccountSource, Intent, PrivateOp, PrivateView, RememberedInfo, StartOp, VaultStatus, WorkerEvent, WorkerRequest } from "./types";

export class WalletError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
  }
}

interface Snapshot {
  readonly status: VaultStatus;
  readonly view: PrivateView | null;
  readonly ops: readonly PrivateOp[];
  readonly remembered: RememberedInfo | null;
  readonly source: AccountSource | null;
  readonly verified: boolean;
  /** Set when the private services can't be reached and there's no market data yet. */
  readonly offline: string | null;
  readonly sheetOpen: boolean;
}

const INITIAL: Snapshot = { status: "checking", view: null, ops: [], remembered: null, source: null, verified: false, offline: null, sheetOpen: false };
let snapshot: Snapshot = INITIAL;
const listeners = new Set<() => void>();
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: WalletError) => void }>();

function publish(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./wallet.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (event: MessageEvent<WorkerEvent | { id: number; ok: boolean; result?: unknown; reason?: string; message?: string }>) => {
    const data = event.data;
    if ("e" in data) {
      if (data.e === "status") {
        publish({ status: data.status, remembered: data.remembered, source: data.source, verified: data.verified, ...(data.status === "unlocked" ? {} : { ops: [] }) });
        if (data.status === "unlocked") resolveEnsure(true);
      } else if (data.e === "offline") publish({ offline: data.code });
      else if (data.e === "view") publish({ view: data.view, offline: null });
      else if (data.e === "ops") {
        publish({ ops: data.ops });
        setPrivateOperations(data.ops);
      }
      return;
    }
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.ok) p.resolve(data.result);
    else p.reject(new WalletError(data.reason ?? "ERROR", data.message ?? "Something went wrong."));
  };
  worker = w;
  return w;
}

function call<T>(request: WorkerRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ id, request });
  });
}

let ensureResolvers: ((ok: boolean) => void)[] = [];

function resolveEnsure(ok: boolean) {
  publish({ sheetOpen: false });
  ensureResolvers.forEach((r) => r(ok));
  ensureResolvers = [];
}

export const closeAccountSheet = () => resolveEnsure(false);

/** Called by any action that needs an open account. Opens the setup sheet and resolves when it's done, so the action continues. */
export function ensureAccount(): Promise<boolean> {
  if (snapshot.status === "unlocked") return Promise.resolve(true);
  publish({ sheetOpen: true });
  return new Promise((resolve) => ensureResolvers.push(resolve));
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  getWorker();
  return () => listeners.delete(cb);
};

/** Every screen renders for everyone. `view` is public market data until an account opens. */
export function usePrivate(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => INITIAL);
}

/** Worker commands. Nothing here returns a key or seed to the page. */
export const wallet = {
  setWallet: (address: string | null) => call<boolean>({ m: "wallet", address }),
  openSigned: (address: string, signature: Hex) => call<boolean>({ m: "signature", address, signature }),
  openSignedTwice: (address: string, first: Hex, second: Hex) => call<boolean>({ m: "signatures", address, first, second }),
  openPasskey: (address: string, output: Uint8Array) => call<boolean>({ m: "prfSeed", address, output }),
  unlockRemembered: (address: string, output: Uint8Array | null) => call<boolean>({ m: "unlockRemembered", address, output }),
  rememberPasskey: (output: Uint8Array, credentialId: string) => call<boolean>({ m: "rememberPasskey", output, credentialId }),
  rememberDevice: () => call<boolean>({ m: "rememberDevice" }),
  forgetRemembered: () => call<boolean>({ m: "forgetRemembered" }),
  lock: () => {
    setPrivateOperations([]);
    return call<boolean>({ m: "lock" });
  },
  prepareShield: (asset: Hex, amount: bigint) => call<{ inner: Hex; depositIndex: number }>({ m: "prepareShield", asset, amount }),
  shieldFinished: (depositIndex: number, ok: boolean) => call<boolean>({ m: "shieldFinished", depositIndex, ok }),
  start: (intent: Intent, title: string, href: string) => call<string>({ m: "start", op: { intent, title, href } satisfies StartOp }),
  retryOp: (id: string) => call<boolean>({ m: "retryOp", id }),
  readMark: (market: bigint) => call<bigint | null>({ m: "readMark", market }),
  cancelOp: (id: string) => call<boolean>({ m: "cancelOp", id }),
  dismissOp: (id: string) => call<boolean>({ m: "dismissOp", id }),
  directOp: (id: string) => call<boolean>({ m: "directOp", id }),
  walletTxSent: (id: string, hash: Hex) => call<boolean>({ m: "walletTxSent", id, hash }),
  walletTxFailed: (id: string, reason: string, message: string) => call<boolean>({ m: "walletTxFailed", id, reason, message }),
  syncNow: () => call<boolean>({ m: "syncNow" }),
};
