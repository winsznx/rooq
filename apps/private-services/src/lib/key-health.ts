import type { Point } from "@rooq/private-sdk";
import type { KeySlot } from "./chain";

/** A KeyRotationActivated event: the full key set from that block on. */
export interface KeyRotationEvent {
  readonly epoch: bigint;
  readonly keys: Readonly<Record<KeySlot, Point>>;
  readonly block: bigint;
}

/** Before any rotation every record is on the genesis keys, so every record counts. */
export const SINCE_DEPLOYMENT = -1n;

const samePoint = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;

/**
 * The block from which every new record for `slot` has been encrypted to `current`: the activation that put `current` in
 * that slot, or the deployment when it is the genesis key. Records landing after it must open with the current key; older
 * ones may only open with a retired key and are expected to go dark once that key is destroyed (D-24). When the events
 * seen so far don't end on `current` (the ledger is behind the key read) every record counts, so nothing is hidden.
 */
export function currentKeySince(genesis: Readonly<Record<KeySlot, Point>>, rotations: readonly KeyRotationEvent[], slot: KeySlot, current: Point): bigint {
  let holder = genesis[slot];
  let since = SINCE_DEPLOYMENT;
  for (const r of rotations) {
    if (samePoint(r.keys[slot], holder)) continue;
    holder = r.keys[slot];
    since = r.block;
  }
  return samePoint(holder, current) ? since : SINCE_DEPLOYMENT;
}

/**
 * Entries strictly after `boundary` in a list sorted by block. A record in the activation block itself may predate the
 * activation transaction, so it is not counted.
 */
export function countAfter(sortedBlocks: readonly bigint[], boundary: bigint): number {
  let lo = 0;
  let hi = sortedBlocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedBlocks[mid]! <= boundary) lo = mid + 1;
    else hi = mid;
  }
  return sortedBlocks.length - lo;
}

/** Unspent records still opened only by a retired key. Expiry and tree position don't matter: each still owes a proof. */
export function retiredUnspent<T extends { readonly keyIndex: number }>(records: Iterable<T>, current: number, isSpent: (record: T) => boolean): number {
  let n = 0;
  for (const r of records) if (r.keyIndex !== current && !isSpent(r)) n++;
  return n;
}

/** How a pending OI delta is opened, and the ring keys of the records the opening came from. */
export interface DeltaSource<O> {
  readonly opening: O;
  readonly keyIndices: readonly number[];
}

/** Pending (unfolded) deltas whose opening needs a record that only a retired key reads. */
export function retiredDeltas<O>(pending: readonly bigint[], sources: ReadonlyMap<bigint, DeltaSource<O>>, current: number): number {
  let n = 0;
  for (const commitment of pending) {
    const source = sources.get(commitment);
    if (source && source.keyIndices.some((k) => k !== current)) n++;
  }
  return n;
}
