import { BPS, LP_PT_LEN, MINIMUM_LIQUIDITY, RECORD_VERSION, ROLE_LP, ROLE_SWAP, T_LP, T_POOL } from "./constants";
import { hash, type Point } from "./crypto";
import { decrypt, encrypt } from "./encryption";
import { randomField, toHex32, type Hex } from "./field";
import { outputRho } from "./note";
import { deriveRecNonce, lockCommitment, lockInput, noteOutput, recNullifier, type HeldLock, type LockTerms } from "./pairs";
import type { MerkleTree } from "./tree";
import type { InputMap, InputValue } from "./witness";

const f = (x: bigint): string => toHex32(x);
const minOf = (a: bigint, b: bigint): bigint => (a < b ? a : b);

export const swapTerms = (pool: bigint, minOut: bigint, secondPool = 0n): LockTerms => ({ role: ROLE_SWAP, market: pool, t2: 0n, t3: minOut, t4: secondPool });
export const lpTerms = (pool: bigint, side: 0n | 1n, minShares: bigint, link: bigint): LockTerms => ({ role: ROLE_LP, market: pool, t2: side, t3: minShares, t4: link });

export function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: bigint): bigint {
  if (reserveIn === 0n || reserveOut === 0n) return 0n;
  const withFee = amountIn * (BPS - feeBps);
  return (withFee * reserveOut) / (reserveIn * BPS + withFee);
}

export function floorSqrt(x: bigint): bigint {
  if (x < 2n) return x;
  let a = x;
  let b = (a + 1n) / 2n;
  while (b < a) [a, b] = [b, (x / b + b) / 2n];
  return a;
}

export interface PoolState {
  readonly r0: bigint;
  readonly r1: bigint;
  readonly supply: bigint;
  readonly lastLeaf: bigint;
  readonly blind: bigint;
}

export const EMPTY_POOL: PoolState = { r0: 0n, r1: 0n, supply: 0n, lastLeaf: 0n, blind: 0n };

export interface PoolInfo {
  readonly id: bigint;
  readonly token0: bigint;
  readonly token1: bigint;
  readonly feeBps: bigint;
  readonly state: PoolState;
  /** On-chain commitment; zero until the pool is seeded. */
  readonly head: bigint;
}

const statePlain = (s: PoolState): bigint[] => [s.r0, s.r1, s.supply, s.lastLeaf, s.blind];
const stateInput = (s: PoolState): InputValue => ({ r0: f(s.r0), r1: f(s.r1), supply: f(s.supply), last_leaf: f(s.lastLeaf), blind: f(s.blind) });

export function poolHead(deployment: bigint, pool: bigint, s: PoolState): bigint {
  return hash([T_POOL, deployment, RECORD_VERSION, pool, ...statePlain(s)]);
}

export function openPoolState(ct: readonly bigint[], sk: bigint): PoolState {
  const [r0, r1, supply, lastLeaf, blind] = decrypt(ct, sk, 5) as [bigint, bigint, bigint, bigint, bigint];
  return { r0, r1, supply, lastLeaf, blind };
}

export interface LpRecord {
  readonly pool: bigint;
  readonly shares: bigint;
  readonly ownerAuth: bigint;
  readonly ownerX: bigint;
  readonly ownerY: bigint;
  readonly expiry: bigint;
  readonly min0: bigint;
  readonly min1: bigint;
  readonly recNonce: bigint;
  readonly blind: bigint;
}

const lpPlain = (l: LpRecord): bigint[] => [l.pool, l.shares, l.ownerAuth, l.ownerX, l.ownerY, l.expiry, l.min0, l.min1, l.recNonce, l.blind];
const lpInput = (l: LpRecord): InputValue => ({
  pool: f(l.pool), shares: f(l.shares), owner_auth: f(l.ownerAuth), owner_x: f(l.ownerX), owner_y: f(l.ownerY), expiry: f(l.expiry), min0: f(l.min0), min1: f(l.min1),
  rec_nonce: f(l.recNonce), blind: f(l.blind),
});

export function lpCommitment(deployment: bigint, l: LpRecord): bigint {
  return hash([T_LP, deployment, RECORD_VERSION, ...lpPlain(l)]);
}

export function openLp(ct: readonly bigint[], sk: bigint, deployment: bigint, commitment: bigint): LpRecord | null {
  let pt: bigint[];
  try {
    pt = decrypt(ct, sk, LP_PT_LEN);
  } catch (err) {
    if (err instanceof Error && /Grumpkin point|ciphertext length/.test(err.message)) return null;
    throw err;
  }
  const [pool, shares, ownerAuth, ownerX, ownerY, expiry, min0, min1, recNonce, blind] = pt as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  const l: LpRecord = { pool, shares, ownerAuth, ownerX, ownerY, expiry, min0, min1, recNonce, blind };
  return lpCommitment(deployment, l) === commitment ? l : null;
}

const flat = (keys: readonly Point[]): string[][] => keys.map((k) => [f(k.x), f(k.y)]);

function nextPool(deployment: bigint, pool: bigint, s: PoolState, keys: readonly [Point, Point, Point]) {
  const head = poolHead(deployment, pool, s);
  const eph = keys.map(() => randomField());
  const cts = keys.map((k, i) => encrypt(statePlain(s), k, eph[i]!));
  return { head, eph, cts };
}

export interface SwapPublic {
  readonly root: Hex;
  readonly nullifier: Hex;
  readonly outCommitment: Hex;
  readonly outCt: readonly Hex[];
  readonly asOf: bigint;
  readonly pool: readonly [bigint, bigint];
  readonly newHead: readonly [Hex, Hex];
  readonly poolCt: readonly (readonly (readonly Hex[])[])[];
}

const ZERO_CT: readonly bigint[] = Array.from({ length: 7 }, () => 0n);

/** Built by whoever executes the intent, normally the coordinator. Throws if the pool cannot satisfy the intent's asset. */
export function swapWitness(r: {
  readonly held: HeldLock;
  readonly deployment: bigint;
  readonly tree: MerkleTree;
  readonly pools: readonly [PoolInfo] | readonly [PoolInfo, PoolInfo];
  readonly asOf: bigint;
  readonly keys: readonly [Point, Point, Point];
}): { inputs: InputMap; publicInputs: SwapPublic; out: bigint; next: readonly PoolState[] } {
  const l = r.held.record;
  const nf = recNullifier(lockCommitment(r.deployment, l), l.recNonce);
  const leaf = BigInt(r.held.leafIndex) + 1n;
  let amount = l.amount;
  let asset = l.asset;
  const next: PoolState[] = [];
  for (const p of r.pools) {
    const zeroForOne = asset === p.token0;
    if (!zeroForOne && asset !== p.token1) throw new Error("asset not in pool");
    const [rIn, rOut] = zeroForOne ? [p.state.r0, p.state.r1] : [p.state.r1, p.state.r0];
    const out = amountOut(amount, rIn, rOut, p.feeBps);
    const [r0, r1] = zeroForOne ? [rIn + amount, rOut - out] : [rOut - out, rIn + amount];
    next.push({ r0, r1, supply: p.state.supply, lastLeaf: leaf, blind: randomField() });
    amount = out;
    asset = zeroForOne ? p.token1 : p.token0;
  }
  const built = next.map((s, i) => nextPool(r.deployment, r.pools[i]!.id, s, r.keys));
  const second: PoolInfo = r.pools[1] ?? { id: 0n, token0: 0n, token1: 0n, feeBps: 0n, state: EMPTY_POOL, head: 0n };
  const rho = outputRho(nf, 0n, 0);
  const out = noteOutput(r.deployment, asset, amount, rho, { auth: l.ownerAuth, pk: { x: l.ownerX, y: l.ownerY } });
  const root = r.tree.root();
  const hop = (i: number): InputValue => ({
    state: stateInput(r.pools[i]?.state ?? EMPTY_POOL), new_blind: f(next[i]?.blind ?? 0n), eph: (built[i]?.eph ?? r.keys.map(() => 0n)).map(f),
  });
  const heads: [bigint, bigint] = [built[0]!.head, built[1]?.head ?? 0n];
  const pct = (i: number): readonly (readonly bigint[])[] => built[i]?.cts ?? [ZERO_CT, ZERO_CT, ZERO_CT];
  return {
    out: amount,
    next,
    inputs: {
      intent: lockInput(l), index: f(BigInt(r.held.leafIndex)), path: r.tree.path(r.held.leafIndex).map(f), hop0: hop(0), hop1: hop(1), out_blind: f(out.blind), out_eph: f(out.eph),
      root: f(root), nf: f(nf), cm_out: f(out.commitment), ct_out: out.ct.map(f), deployment: f(r.deployment), now: f(r.asOf),
      pool: [f(r.pools[0].id), f(second.id)], token0: [f(r.pools[0].token0), f(second.token0)], token1: [f(r.pools[0].token1), f(second.token1)],
      fee_bps: [f(r.pools[0].feeBps), f(second.feeBps)], head: [f(r.pools[0].head), f(second.head)], new_head: heads.map(f),
      ct_pool: [pct(0).map((c) => c.map(f)), pct(1).map((c) => c.map(f))], keys: flat(r.keys),
    },
    publicInputs: {
      root: toHex32(root), nullifier: toHex32(nf), outCommitment: toHex32(out.commitment), outCt: out.ct.map(toHex32), asOf: r.asOf, pool: [r.pools[0].id, second.id],
      newHead: [toHex32(heads[0]), toHex32(heads[1])], poolCt: [pct(0).map((c) => c.map(toHex32)), pct(1).map((c) => c.map(toHex32))],
    },
  };
}

/** Same integer rules as SpotPool.addLiquidity. */
export function lpAddOutcome(d0: bigint, d1: bigint, s: PoolState): { used0: bigint; used1: bigint; shares: bigint; supply: bigint } {
  if (s.supply === 0n) {
    const root = floorSqrt(d0 * d1);
    return { used0: d0, used1: d1, shares: root > MINIMUM_LIQUIDITY ? root - MINIMUM_LIQUIDITY : 0n, supply: root };
  }
  const optimal1 = (d0 * s.r1) / s.r0;
  const [used0, used1] = optimal1 <= d1 ? [d0, optimal1] : [(d1 * s.r0) / s.r1, d1];
  const shares = minOf((used0 * s.supply) / s.r0, (used1 * s.supply) / s.r1);
  return { used0, used1, shares, supply: s.supply + shares };
}

export interface LpAddPublic {
  readonly root: Hex;
  readonly nullifiers: readonly [Hex, Hex];
  readonly newHead: Hex;
  readonly lpCommitment: Hex;
  readonly lpCt: readonly (readonly Hex[])[];
  readonly refundCommitments: readonly [Hex, Hex];
  readonly refundCt: readonly (readonly Hex[])[];
  readonly poolCt: readonly (readonly Hex[])[];
  readonly asOf: bigint;
  readonly pool: bigint;
}

export function lpAddWitness(r: {
  readonly lock0: HeldLock;
  readonly lock1: HeldLock;
  readonly pool: PoolInfo;
  readonly deployment: bigint;
  readonly tree: MerkleTree;
  readonly asOf: bigint;
  readonly keys: readonly [Point, Point, Point];
}): { inputs: InputMap; publicInputs: LpAddPublic; record: LpRecord; outcome: ReturnType<typeof lpAddOutcome>; next: PoolState } {
  const [a, b] = [r.lock0.record, r.lock1.record];
  const outcome = lpAddOutcome(a.amount, b.amount, r.pool.state);
  const nf0 = recNullifier(lockCommitment(r.deployment, a), a.recNonce);
  const nf1 = recNullifier(lockCommitment(r.deployment, b), b.recNonce);
  const leaf = BigInt(Math.max(r.lock0.leafIndex, r.lock1.leafIndex)) + 1n;
  const s = r.pool.state;
  const next: PoolState = { r0: s.r0 + outcome.used0, r1: s.r1 + outcome.used1, supply: outcome.supply, lastLeaf: leaf, blind: randomField() };
  const built = nextPool(r.deployment, r.pool.id, next, r.keys);
  const salt = randomField();
  const record: LpRecord = {
    pool: r.pool.id, shares: outcome.shares, ownerAuth: a.ownerAuth, ownerX: a.ownerX, ownerY: a.ownerY, expiry: 0n, min0: 0n, min1: 0n,
    recNonce: deriveRecNonce(nf0, nf1, 0n, salt), blind: randomField(),
  };
  const owner = { auth: a.ownerAuth, pk: { x: a.ownerX, y: a.ownerY } };
  const lpKeys = [owner.pk, ...r.keys];
  const lpEph = lpKeys.map(() => randomField());
  const lpCts = lpKeys.map((k, i) => encrypt(lpPlain(record), k, lpEph[i]!));
  const refunds = [
    noteOutput(r.deployment, r.pool.token0, a.amount - outcome.used0, outputRho(nf0, nf1, 0), owner),
    noteOutput(r.deployment, r.pool.token1, b.amount - outcome.used1, outputRho(nf0, nf1, 1), owner),
  ];
  const cm = lpCommitment(r.deployment, record);
  const root = r.tree.root();
  const held = (h: HeldLock): InputValue => ({ lock: lockInput(h.record), index: f(BigInt(h.leafIndex)), path: r.tree.path(h.leafIndex).map(f) });
  return {
    record, outcome, next,
    inputs: {
      lock0: held(r.lock0), lock1: held(r.lock1), state: stateInput(s), new_blind: f(next.blind), lp_salt: f(salt), lp_blind: f(record.blind), lp_eph: lpEph.map(f),
      refund_blind: refunds.map((x) => f(x.blind)), refund_eph: refunds.map((x) => f(x.eph)), pool_eph: built.eph.map(f),
      root: f(root), nf: [f(nf0), f(nf1)], head: f(r.pool.head), new_head: f(built.head), cm_lp: f(cm), ct_lp: lpCts.map((c) => c.map(f)), cm_refund: refunds.map((x) => f(x.commitment)),
      ct_refund: refunds.map((x) => x.ct.map(f)), ct_pool: built.cts.map((c) => c.map(f)), deployment: f(r.deployment), now: f(r.asOf), pool: f(r.pool.id), token0: f(r.pool.token0), token1: f(r.pool.token1), keys: flat(r.keys),
    },
    publicInputs: {
      root: toHex32(root), nullifiers: [toHex32(nf0), toHex32(nf1)], newHead: toHex32(built.head), lpCommitment: toHex32(cm), lpCt: lpCts.map((c) => c.map(toHex32)),
      refundCommitments: [toHex32(refunds[0]!.commitment), toHex32(refunds[1]!.commitment)], refundCt: refunds.map((x) => x.ct.map(toHex32)), poolCt: built.cts.map((c) => c.map(toHex32)), asOf: r.asOf, pool: r.pool.id,
    },
  };
}

export interface LpSetPublic {
  readonly root: Hex;
  readonly nullifier: Hex;
  readonly nextCommitment: Hex;
  readonly ct: readonly (readonly Hex[])[];
  readonly asOf: bigint;
  readonly mode: bigint;
}

/** Mode 0: the owner opens a removal request. Mode 1: anyone returns an expired request to idle (sk unused). */
export function lpSetWitness(r: {
  readonly claim: LpRecord;
  readonly leafIndex: number;
  readonly deployment: bigint;
  readonly tree: MerkleTree;
  readonly mode: bigint;
  readonly sk: bigint;
  readonly min0: bigint;
  readonly min1: bigint;
  readonly expiry: bigint;
  readonly asOf: bigint;
  readonly keys: readonly [Point, Point, Point];
}): { inputs: InputMap; publicInputs: LpSetPublic; record: LpRecord } {
  const c = r.claim;
  const nf = recNullifier(lpCommitment(r.deployment, c), c.recNonce);
  const salt = randomField();
  const opening = r.mode === 0n;
  const record: LpRecord = {
    ...c, expiry: opening ? r.expiry : 0n, min0: opening ? r.min0 : 0n, min1: opening ? r.min1 : 0n, recNonce: deriveRecNonce(nf, 0n, 0n, salt), blind: randomField(),
  };
  const recipients = [{ x: c.ownerX, y: c.ownerY }, ...r.keys];
  const eph = recipients.map(() => randomField());
  const cts = recipients.map((k, i) => encrypt(lpPlain(record), k, eph[i]!));
  const cm = lpCommitment(r.deployment, record);
  const root = r.tree.root();
  return {
    record,
    inputs: {
      claim: lpInput(c), index: f(BigInt(r.leafIndex)), path: r.tree.path(r.leafIndex).map(f), sk: f(r.sk), min0: f(r.min0), min1: f(r.min1), expiry: f(r.expiry), salt: f(salt), new_blind: f(record.blind), eph: eph.map(f),
      root: f(root), nf: f(nf), cm_next: f(cm), ct: cts.map((x) => x.map(f)), deployment: f(r.deployment), now: f(r.asOf), mode: f(r.mode), keys: flat(r.keys),
    },
    publicInputs: { root: toHex32(root), nullifier: toHex32(nf), nextCommitment: toHex32(cm), ct: cts.map((x) => x.map(toHex32)), asOf: r.asOf, mode: r.mode },
  };
}

export interface LpRemovePublic {
  readonly root: Hex;
  readonly nullifier: Hex;
  readonly newHead: Hex;
  readonly outCommitments: readonly [Hex, Hex];
  readonly outCt: readonly (readonly Hex[])[];
  readonly poolCt: readonly (readonly Hex[])[];
  readonly asOf: bigint;
  readonly pool: bigint;
}

export function lpRemoveWitness(r: {
  readonly claim: LpRecord;
  readonly leafIndex: number;
  readonly pool: PoolInfo;
  readonly deployment: bigint;
  readonly tree: MerkleTree;
  readonly asOf: bigint;
  readonly keys: readonly [Point, Point, Point];
}): { inputs: InputMap; publicInputs: LpRemovePublic; out0: bigint; out1: bigint; next: PoolState } {
  const c = r.claim;
  const s = r.pool.state;
  const nf = recNullifier(lpCommitment(r.deployment, c), c.recNonce);
  const out0 = (c.shares * s.r0) / s.supply;
  const out1 = (c.shares * s.r1) / s.supply;
  const next: PoolState = { r0: s.r0 - out0, r1: s.r1 - out1, supply: s.supply - c.shares, lastLeaf: BigInt(r.leafIndex) + 1n, blind: randomField() };
  const built = nextPool(r.deployment, r.pool.id, next, r.keys);
  const owner = { auth: c.ownerAuth, pk: { x: c.ownerX, y: c.ownerY } };
  const outs = [noteOutput(r.deployment, r.pool.token0, out0, outputRho(nf, 0n, 0), owner), noteOutput(r.deployment, r.pool.token1, out1, outputRho(nf, 0n, 1), owner)];
  const root = r.tree.root();
  return {
    out0, out1, next,
    inputs: {
      claim: lpInput(c), index: f(BigInt(r.leafIndex)), path: r.tree.path(r.leafIndex).map(f), state: stateInput(s), new_blind: f(next.blind), out_blind: outs.map((x) => f(x.blind)), out_eph: outs.map((x) => f(x.eph)), pool_eph: built.eph.map(f),
      root: f(root), nf: f(nf), head: f(r.pool.head), new_head: f(built.head), cm_out: outs.map((x) => f(x.commitment)), ct_out: outs.map((x) => x.ct.map(f)), ct_pool: built.cts.map((c2) => c2.map(f)),
      deployment: f(r.deployment), now: f(r.asOf), pool: f(r.pool.id), token0: f(r.pool.token0), token1: f(r.pool.token1), keys: flat(r.keys),
    },
    publicInputs: {
      root: toHex32(root), nullifier: toHex32(nf), newHead: toHex32(built.head), outCommitments: [toHex32(outs[0]!.commitment), toHex32(outs[1]!.commitment)], outCt: outs.map((x) => x.ct.map(toHex32)), poolCt: built.cts.map((c2) => c2.map(toHex32)), asOf: r.asOf, pool: r.pool.id,
    },
  };
}
