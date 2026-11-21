import { getAddress, isAddress, type Address, type Hex } from "viem";
import { deploymentIdOf, type DeploymentPin } from "./deployment-pin";

export const NOTE_RECEIPT_TYPE = "rooq-note-receipt";
export const NOTE_RECEIPT_VERSION = 1;

/** ShieldedPool queue entry kinds (`ShieldedPool.sol` KIND_DEPOSIT, KIND_LEAF). */
const KIND_DEPOSIT = 1;
const KIND_LEAF = 2;

const ADDRESS_MASK = (1n << 160n) - 1n;
const FIELD_HEX = /^0x[0-9a-fA-F]{1,64}$/;
const DECIMAL = /^\d{1,78}$/;

/**
 * Opens one private note to whoever holds the receipt: token, amount and leaf. `inner` hides the owner, `rho` and
 * `blind`, so the receipt can't be used to spend the note, compute its nullifier or find the owner's other notes.
 */
export interface NoteReceipt {
  readonly type: typeof NOTE_RECEIPT_TYPE;
  readonly version: typeof NOTE_RECEIPT_VERSION;
  readonly chainId: number;
  readonly deploymentId: string;
  readonly leafIndex: number;
  readonly asset: Address;
  readonly value: string;
  readonly inner: Hex;
}

export interface ReceiptNote {
  readonly leafIndex: number;
  readonly asset: bigint;
  readonly value: bigint;
  readonly inner: bigint;
}

export interface QueueEntry {
  readonly kind: number;
  readonly a: Hex;
  readonly b: Hex;
  readonly c: Hex;
}

export type ReceiptCheck =
  | { readonly ok: true; readonly asset: Address; readonly value: bigint; readonly leafIndex: number; readonly origin: "deposit" | "note" }
  | { readonly ok: false; readonly reason: ReceiptFailure };

export type ReceiptFailure = "MALFORMED" | "OTHER_DEPLOYMENT" | "NO_SUCH_LEAF" | "MISMATCH";

const hex32 = (x: bigint): Hex => `0x${x.toString(16).padStart(64, "0")}`;

export function noteReceipt(note: ReceiptNote, deployment: Pick<DeploymentPin, "chainId" | "deploymentId">): NoteReceipt {
  return {
    type: NOTE_RECEIPT_TYPE,
    version: NOTE_RECEIPT_VERSION,
    chainId: deployment.chainId,
    deploymentId: deployment.deploymentId.toString(),
    leafIndex: note.leafIndex,
    asset: getAddress(`0x${(note.asset & ADDRESS_MASK).toString(16).padStart(40, "0")}`),
    value: note.value.toString(),
    inner: hex32(note.inner),
  };
}

/** Accepts only the exact shape `noteReceipt` writes, so a hand-edited file fails loudly instead of half-checking. */
export function parseNoteReceipt(input: unknown): NoteReceipt | null {
  if (typeof input !== "object" || input === null) return null;
  const r = input as Record<string, unknown>;
  if (r.type !== NOTE_RECEIPT_TYPE || r.version !== NOTE_RECEIPT_VERSION) return null;
  if (typeof r.chainId !== "number" || !Number.isSafeInteger(r.chainId)) return null;
  if (typeof r.leafIndex !== "number" || !Number.isSafeInteger(r.leafIndex) || r.leafIndex < 0) return null;
  if (typeof r.deploymentId !== "string" || !DECIMAL.test(r.deploymentId)) return null;
  if (typeof r.value !== "string" || !DECIMAL.test(r.value)) return null;
  if (typeof r.asset !== "string" || !isAddress(r.asset, { strict: false })) return null;
  if (typeof r.inner !== "string" || !FIELD_HEX.test(r.inner)) return null;
  return {
    type: NOTE_RECEIPT_TYPE, version: NOTE_RECEIPT_VERSION, chainId: r.chainId, deploymentId: r.deploymentId, leafIndex: r.leafIndex,
    asset: getAddress(r.asset), value: r.value, inner: r.inner as Hex,
  };
}

export interface ReceiptCheckDeps {
  readonly pin: DeploymentPin;
  readonly commitmentOf: (deploymentId: bigint, asset: bigint, value: bigint, inner: bigint) => bigint;
  /** Reads `ShieldedPool.queueEntry(leafIndex)` from the chain, or null when the leaf doesn't exist yet. */
  readonly readEntry: (leafIndex: number) => Promise<QueueEntry | null>;
}

/**
 * Checks a receipt against the pool's own storage. A deposit leaf stores (inner, asset, amount) and every other leaf
 * stores its commitment, so either the stored fields or the recomputed commitment must match. It proves the note was
 * created in this deployment. It doesn't prove who holds it or that it is still unspent.
 */
export async function checkNoteReceipt(receipt: NoteReceipt, deps: ReceiptCheckDeps): Promise<ReceiptCheck> {
  const { pin } = deps;
  const id = BigInt(receipt.deploymentId);
  if (receipt.chainId !== pin.chainId || id !== pin.deploymentId || id !== deploymentIdOf(pin.chainId, pin.pool)) return { ok: false, reason: "OTHER_DEPLOYMENT" };
  const asset = BigInt(receipt.asset);
  const value = BigInt(receipt.value);
  const inner = BigInt(receipt.inner);
  const entry = await deps.readEntry(receipt.leafIndex);
  if (!entry) return { ok: false, reason: "NO_SUCH_LEAF" };
  const result = { ok: true, asset: receipt.asset, value, leafIndex: receipt.leafIndex } as const;
  if (entry.kind === KIND_DEPOSIT) {
    const matches = BigInt(entry.a) === inner && BigInt(entry.b) === asset && BigInt(entry.c) === value;
    return matches ? { ...result, origin: "deposit" } : { ok: false, reason: "MISMATCH" };
  }
  if (entry.kind === KIND_LEAF) {
    return BigInt(entry.a) === deps.commitmentOf(id, asset, value, inner) ? { ...result, origin: "note" } : { ok: false, reason: "MISMATCH" };
  }
  return { ok: false, reason: "MISMATCH" };
}
