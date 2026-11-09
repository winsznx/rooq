import { AMOUNT_LIMIT, APPEND_BATCH, FREE_DOMAIN, KIND_DEPOSIT, KIND_LEAF, TREE_DEPTH } from "./constants";
import type { Point } from "./crypto";
import { encrypt } from "./encryption";
import { randomField, toHex32, type Hex } from "./field";
import { ownerTag, type PrivateAddress, type WalletKeys } from "./keys";
import type { MerkleTree } from "./tree";
import { noteCommitment, noteInner, outputRho, ownerNullifier, type OwnedNote } from "./note";

/** Nested input map accepted by noir_js `Noir.execute`. */
export type InputValue = string | InputValue[] | { [k: string]: InputValue };
export type InputMap = { [k: string]: InputValue };

const f = (x: bigint): string => toHex32(x);
const pt = (p: Point): InputValue => ({ x: f(p.x), y: f(p.y) });

/** One ShieldedPool queue entry, as stored on chain. */
export interface QueueEntry {
  readonly kind: bigint;
  readonly a: bigint;
  readonly b: bigint;
  readonly c: bigint;
}

export function leafOf(e: QueueEntry, deployment: bigint): bigint {
  if (e.kind === KIND_DEPOSIT) return noteCommitment(deployment, e.b, e.c, e.a);
  if (e.kind === KIND_LEAF) return e.a;
  throw new Error(`unknown queue entry kind ${e.kind}`);
}

/**
 * Witness for appending `entries` (at most APPEND_BATCH) starting at tree.size. Mutates `tree` to the new state,
 * so callers pass a clone unless the batch is certain to be accepted.
 */
export function appendWitness(tree: MerkleTree, entries: readonly QueueEntry[], deployment: bigint): { inputs: InputMap; newRoot: bigint } {
  if (entries.length === 0 || entries.length > APPEND_BATCH) throw new RangeError("append batch size");
  const oldRoot = tree.root();
  const start = tree.size;
  const paths: InputValue[] = [];
  const zeroPath = Array.from({ length: TREE_DEPTH }, () => f(0n));
  for (const e of entries) {
    const index = tree.size;
    paths.push(tree.path(index).map(f));
    tree.insert(leafOf(e, deployment));
  }
  const pad = <T>(xs: T[], v: T): T[] => [...xs, ...Array.from({ length: APPEND_BATCH - xs.length }, () => v)];
  return {
    newRoot: tree.root(),
    inputs: {
      paths: pad(paths, zeroPath),
      deployment: f(deployment),
      old_root: f(oldRoot),
      new_root: f(tree.root()),
      start_index: f(BigInt(start)),
      kind: pad(entries.map((e) => f(e.kind)), f(0n)),
      a: pad(entries.map((e) => f(e.a)), f(0n)),
      b: pad(entries.map((e) => f(e.b)), f(0n)),
      c: pad(entries.map((e) => f(e.c)), f(0n)),
    },
  };
}

/** Arguments of ShieldedPool.spend after the proof. */
export interface SpendPublic {
  readonly root: Hex;
  readonly nullifiers: readonly [Hex, Hex];
  readonly commitments: readonly [Hex, Hex, Hex];
  readonly ciphertexts: readonly [readonly Hex[], readonly Hex[], readonly Hex[]];
  readonly publicAsset: Hex;
  readonly withdrawAmount: bigint;
  readonly withdrawRecipient: Hex;
  readonly relayer: Hex;
  readonly relayerFee: bigint;
}

export interface SpendRequest {
  readonly keys: WalletKeys;
  readonly deployment: bigint;
  readonly tree: MerkleTree;
  readonly asset: bigint;
  /** One or two notes of `asset`; a missing second input becomes a zero-value dummy. */
  readonly inputs: readonly OwnedNote[];
  /** Up to three private outputs; a missing one becomes a zero-value note to the spender. */
  readonly outputs: readonly { readonly value: bigint; readonly to: PrivateAddress }[];
  readonly withdraw?: { readonly amount: bigint; readonly recipient: bigint };
  readonly relayer?: { readonly address: bigint; readonly fee: bigint };
}

export interface SpendWitness {
  readonly inputs: InputMap;
  readonly publicInputs: SpendPublic;
  /** What each output decrypts to, for the sender's own records. */
  readonly outputs: readonly { readonly commitment: bigint; readonly rho: bigint; readonly blind: bigint; readonly value: bigint }[];
}

const addr = (x: bigint): Hex => `0x${x.toString(16).padStart(40, "0")}`;

export function spendWitness(r: SpendRequest): SpendWitness {
  if (r.inputs.length < 1 || r.inputs.length > 2) throw new RangeError("one or two input notes");
  if (r.outputs.length > 3) throw new RangeError("at most three outputs");
  for (const n of r.inputs) if (n.asset !== r.asset) throw new Error("input note of another asset");
  const withdraw = r.withdraw ?? { amount: 0n, recipient: 0n };
  const relayer = r.relayer ?? { address: 0n, fee: 0n };
  const root = r.tree.root();
  const self = { auth: r.keys.auth, pk: r.keys.pk };

  const ins = [...r.inputs];
  if (ins.length === 1) {
    const rho = randomField();
    const blind = randomField();
    const cm = noteCommitment(r.deployment, r.asset, 0n, noteInner(r.keys.owner, rho, blind));
    ins.push({ leafIndex: 0, asset: r.asset, value: 0n, rho, blind, commitment: cm, nullifier: ownerNullifier(r.keys.nk, cm) });
  }
  const outs = [...r.outputs];
  while (outs.length < 3) outs.push({ value: 0n, to: self });

  const totalIn = ins.reduce((s, n) => s + n.value, 0n);
  const totalOut = outs.reduce((s, o) => s + o.value, 0n) + withdraw.amount + relayer.fee;
  if (totalIn !== totalOut) throw new Error(`inputs ${totalIn} != outputs ${totalOut}`);
  for (const v of [...outs.map((o) => o.value), withdraw.amount, relayer.fee]) {
    if (v < 0n || v >= AMOUNT_LIMIT) throw new RangeError("amount out of range");
  }

  const nf = ins.map((n) => n.nullifier) as [bigint, bigint];
  const built = outs.map((o, i) => {
    const rho = outputRho(nf[0], nf[1], i);
    const blind = randomField();
    const eph = randomField();
    const commitment = noteCommitment(r.deployment, r.asset, o.value, noteInner(ownerTag(o.to), rho, blind));
    const ct = encrypt([FREE_DOMAIN, r.asset, o.value, rho, blind], o.to.pk, eph);
    return { o, rho, blind, eph, commitment, ct };
  });

  const pays = withdraw.amount + relayer.fee !== 0n;
  const publicAsset = pays ? r.asset : 0n;
  const zeroPath = Array.from({ length: r.tree.depth }, () => f(0n));
  const inputs: InputMap = {
    sk: f(r.keys.sk),
    own_pk: pt(r.keys.pk),
    asset: f(r.asset),
    ins: ins.map((n) => ({
      value: f(n.value),
      rho: f(n.rho),
      blind: f(n.blind),
      index: f(BigInt(n.leafIndex)),
      path: n.value === 0n ? zeroPath : r.tree.path(n.leafIndex).map(f),
    })),
    outs: built.map((b) => ({ value: f(b.o.value), recipient_auth: f(b.o.to.auth), recipient_pk: pt(b.o.to.pk), blind: f(b.blind), eph: f(b.eph) })),
    root: f(root),
    nf: nf.map(f),
    cm_out: built.map((b) => f(b.commitment)),
    ct: built.map((b) => b.ct.map(f)),
    deployment: f(r.deployment),
    public_asset: f(publicAsset),
    withdraw_amount: f(withdraw.amount),
    withdraw_recipient: f(withdraw.recipient),
    relayer: f(relayer.address),
    relayer_fee: f(relayer.fee),
  };
  return {
    inputs,
    publicInputs: {
      root: toHex32(root),
      nullifiers: [toHex32(nf[0]), toHex32(nf[1])],
      commitments: [toHex32(built[0]!.commitment), toHex32(built[1]!.commitment), toHex32(built[2]!.commitment)],
      ciphertexts: [built[0]!.ct.map(toHex32), built[1]!.ct.map(toHex32), built[2]!.ct.map(toHex32)],
      publicAsset: addr(publicAsset),
      withdrawAmount: withdraw.amount,
      withdrawRecipient: addr(withdraw.recipient),
      relayer: addr(relayer.address),
      relayerFee: relayer.fee,
    },
    outputs: built.map((b) => ({ commitment: b.commitment, rho: b.rho, blind: b.blind, value: b.o.value })),
  };
}
