"use client";

import { useSyncExternalStore } from "react";
import type { Hash } from "viem";

/**
 * Operation center state. One record per user-authorised action, kept across navigation and reload.
 *
 * The stage names follow the private V1 state machine (addendum UX-02). Public wallet transactions (the shield step)
 * are stored here in localStorage and hold only what is public onchain, plus the action's label. Private operations
 * live encrypted in the wallet worker and are merged in below while the account is unlocked.
 */
export type OperationStage =
  | "checking"
  | "awaiting_signature"
  | "preparing_proof"
  | "queued"
  | "submitted"
  | "included"
  | "waiting"
  | "confirmed"
  | "rejected"
  | "expired"
  | "cancelled"
  | "failed"
  | "rechecking"
  | "recovery_required";

export type OperationKind = "trade" | "funds" | "liquidity" | "maker" | "market" | "faucet";

export interface OperationIcon {
  readonly asset?: Hash | `0x${string}`;
  readonly market?: bigint;
}

export interface OperationStep {
  readonly label: string;
  readonly stage: OperationStage | "not_started";
  readonly hash?: Hash;
  readonly blockNumber?: string;
  readonly blockHash?: string;
  readonly message?: string;
}

export interface Operation {
  readonly id: string;
  readonly wallet: string;
  readonly chainId: number;
  readonly kind: OperationKind;
  readonly title: string;
  readonly href: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly stage: OperationStage;
  readonly steps: readonly OperationStep[];
  /** Unix seconds in chain time when a signed quote stops being valid; null when no quote is involved. */
  readonly quoteExpiresAt: number | null;
  readonly finalityNote: string | null;
  readonly message: string | null;
  readonly dismissed: boolean;
  readonly icons?: readonly OperationIcon[];
  /** Sent on the private deployment's chain; its receipts are read from there. */
  readonly privateChain?: boolean;
  /** Present on operations held in the encrypted private store rather than in localStorage. */
  readonly privateActions?: { readonly canRetry: boolean; readonly canCancel: boolean; readonly reason: string | null; readonly offerDirect: boolean };
}

interface StageMeta {
  readonly label: string;
  readonly detail: string;
  readonly tone: "active" | "done" | "stopped" | "warning";
  readonly canonical: string;
}

export const STAGE_META: Record<OperationStage, StageMeta> = {
  checking: { label: "Checking with the contract", detail: "Rooq simulates the call before your wallet opens.", tone: "active", canonical: "Reviewing" },
  awaiting_signature: { label: "Waiting for your wallet", detail: "Approve or reject the request in your wallet.", tone: "active", canonical: "Reviewing" },
  preparing_proof: { label: "Proving on this device", detail: "Building the proof here. Your keys stay on this device.", tone: "active", canonical: "Preparing proof" },
  queued: { label: "Sending", detail: "Going to the relayer.", tone: "active", canonical: "Queued" },
  submitted: { label: "Submitted", detail: "The transaction left your wallet and is waiting for a block.", tone: "active", canonical: "Submitted" },
  included: { label: "Included", detail: "In a block, waiting for confirmation.", tone: "active", canonical: "Included" },
  waiting: { label: "Waiting", detail: "Waiting on the condition described below.", tone: "active", canonical: "Submitted" },
  confirmed: { label: "Confirmed", detail: "Confirmed by the chain. Finality is shown separately.", tone: "done", canonical: "Confirmed" },
  rejected: { label: "Rejected in wallet", detail: "You declined the request. Nothing was sent.", tone: "stopped", canonical: "Rejected" },
  expired: { label: "Quote expired", detail: "The signed quote ran out before it was used.", tone: "stopped", canonical: "Expired" },
  cancelled: { label: "Cancelled", detail: "This operation was stopped before submission.", tone: "stopped", canonical: "Cancelled" },
  failed: { label: "Failed", detail: "The contract rejected this transaction.", tone: "stopped", canonical: "Failed" },
  rechecking: { label: "Rechecking", detail: "No current receipt. It may still land, so Rooq keeps checking the chain.", tone: "warning", canonical: "Rechecking after reorg" },
  recovery_required: { label: "Needs your attention", detail: "Rooq can't tell how this ended. Check your wallet history before trying again.", tone: "warning", canonical: "Recovery required" },
};

/** The stages shown on the public-tx progress track. A private operation would use its own list. */
export const PRIVATE_TRACK: readonly { stage: OperationStage; label: string }[] = [
  { stage: "preparing_proof", label: "Prove" },
  { stage: "queued", label: "Send" },
  { stage: "submitted", label: "Land" },
  { stage: "confirmed", label: "Done" },
];

export const PUBLIC_TRACK: readonly { stage: OperationStage; label: string }[] = [
  { stage: "checking", label: "Check" },
  { stage: "awaiting_signature", label: "Sign" },
  { stage: "submitted", label: "Submit" },
  { stage: "confirmed", label: "Confirm" },
];

const ACTIVE: ReadonlySet<OperationStage> = new Set(["checking", "awaiting_signature", "preparing_proof", "queued", "submitted", "included", "waiting", "rechecking"]);

export const isActive = (op: Operation) => ACTIVE.has(op.stage);
export const needsAttention = (op: Operation) => op.stage === "recovery_required" || op.stage === "rechecking";

const STORAGE_KEY = "rooq-operations-v1";
const MAX_RECORDS = 30;
const RETAIN_MS = 7 * 24 * 3600 * 1000;
/** A prompt older than this with no live owner has lost its page. */
const ORPHAN_AFTER_MS = 90_000;
/** A confirmed block can be replaced for a while; receipts are re-verified for this long. */
export const REORG_WATCH_MS = 10 * 60 * 1000;
/** With no receipt after this long, keep the claim visible but ask the person to look. */
export const RECOVERY_AFTER_MS = 15 * 60 * 1000;

export interface PersistenceAdapter {
  load(): Operation[];
  save(ops: readonly Operation[]): void;
}

const localAdapter: PersistenceAdapter = {
  load() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Operation[]) : [];
    } catch (error) {
      console.warn("rooq: operations unreadable", error);
      return [];
    }
  },
  save(ops) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ops));
    } catch (error) {
      console.warn("rooq: operations not stored", error);
    }
  },
};

const EMPTY: readonly Operation[] = [];
const listeners = new Set<() => void>();
/** Operations driven by a transaction runner alive in this page; everything else is reconciled. */
const owned = new Set<string>();
let adapter = localAdapter;
let state: readonly Operation[] | null = null;

function current(): readonly Operation[] {
  if (state === null) {
    const now = Date.now();
    state = adapter.load().filter((op) => now - op.updatedAt < RETAIN_MS);
  }
  return state;
}

function commit(next: readonly Operation[]) {
  state = next.slice(0, MAX_RECORDS);
  adapter.save(state);
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    state = adapter.load();
    cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function useOperations(): readonly Operation[] {
  return useSyncExternalStore(subscribeMerged, merged, () => EMPTY);
}

export interface PrivateOperationInput {
  readonly id: string;
  readonly kind: OperationKind;
  readonly title: string;
  readonly href: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly stage: OperationStage;
  readonly steps: readonly OperationStep[];
  readonly quoteExpiresAt: number | null;
  readonly finalityNote: string | null;
  readonly message: string | null;
  readonly dismissed: boolean;
  readonly canRetry: boolean;
  readonly canCancel: boolean;
  readonly reason: string | null;
  readonly offerDirect: boolean;
  readonly icons?: readonly OperationIcon[];
}

let privateOps: readonly Operation[] = EMPTY;
let mergedCache: { pub: readonly Operation[]; priv: readonly Operation[]; out: readonly Operation[] } | null = null;
const mergedListeners = new Set<() => void>();

function merged(): readonly Operation[] {
  const pub = current();
  if (mergedCache && mergedCache.pub === pub && mergedCache.priv === privateOps) return mergedCache.out;
  const out = [...privateOps, ...pub].sort((a, b) => b.createdAt - a.createdAt);
  mergedCache = { pub, priv: privateOps, out };
  return out;
}

function subscribeMerged(cb: () => void) {
  mergedListeners.add(cb);
  const off = subscribe(cb);
  return () => {
    mergedListeners.delete(cb);
    off();
  };
}

/** Private operations belong to the private account, not a wallet address. They disappear while the account is locked. */
export function setPrivateOperations(ops: readonly PrivateOperationInput[]) {
  privateOps = ops.map((o) => ({ ...o, wallet: "private", chainId: 0, privateActions: { canRetry: o.canRetry, canCancel: o.canCancel, reason: o.reason, offerDirect: o.offerDirect } }));
  mergedListeners.forEach((l) => l());
}

export function setPersistenceAdapter(next: PersistenceAdapter) {
  adapter = next;
  state = null;
  listeners.forEach((l) => l());
}

export function createOperation(input: Pick<Operation, "wallet" | "chainId" | "kind" | "title" | "href" | "steps" | "quoteExpiresAt" | "icons" | "privateChain">): string {
  const now = Date.now();
  const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  owned.add(id);
  commit([{ ...input, id, createdAt: now, updatedAt: now, stage: "checking", finalityNote: null, message: null, dismissed: false }, ...current()]);
  return id;
}

export function patchOperation(id: string, patch: Partial<Omit<Operation, "id" | "createdAt">>) {
  commit(current().map((op) => (op.id === id ? { ...op, ...patch, updatedAt: Date.now() } : op)));
}

export function releaseOperation(id: string) {
  owned.delete(id);
}

export function dismissOperation(id: string) {
  commit(current().map((op) => (op.id === id ? { ...op, dismissed: true } : op)));
}

export function isOwned(id: string) {
  return owned.has(id);
}

/** A wallet prompt cannot outlive its page: past the grace period the outcome is unknown, so say that. */
export function sweepOrphans(now: number) {
  const orphans = current().filter((op) => !owned.has(op.id) && (op.stage === "checking" || op.stage === "awaiting_signature") && now - op.updatedAt > ORPHAN_AFTER_MS);
  if (orphans.length === 0) return;
  const ids = new Set(orphans.map((o) => o.id));
  commit(current().map((op) => (ids.has(op.id) ? { ...op, stage: "recovery_required", updatedAt: now, message: "The page closed before your wallet answered. Check your wallet history before trying again. Rooq will not resend this." } : op)));
}
