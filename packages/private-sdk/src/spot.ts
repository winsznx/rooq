import { BPS, LP_PT_LEN, MINIMUM_LIQUIDITY, POOL_CT_LEN, POOL_PT_LEN, PRICE_BAND_BITS, RECORD_VERSION, ROLE_LP, ROLE_SWAP, T_LP, T_POOL, WAD } from "./constants";
import { hash, type Point } from "./crypto";
import { decrypt, encrypt } from "./encryption";
import { randomField, toHex32, type Hex } from "./field";
import { outputRho } from "./note";
import type { PrivateAddress } from "./keys";
import { ceilDiv, deriveRecNonce, lockCommitment, lockInput, noteOutput, recNullifier, type HeldLock, type LockTerms } from "./pairs";
import type { MerkleTree } from "./tree";
import type { InputMap, InputValue } from "./witness";

const f = (x: bigint): string => toHex32(x);
const minOf = (a: bigint, b: bigint): bigint => (a < b ? a : b);

export const swapTerms = (pool: bigint, minOut: bigint, secondPool = 0n): LockTerms => ({ role: ROLE_SWAP, market: pool, t2: 0n, t3: minOut, t4: secondPool });
/** One LP add lock. `bound` is the lowest accepted price on side 0 and the highest on side 1 (WAD, token1 per token0). */
export const lpTerms = (pool: bigint, side: 0n | 1n, bound: bigint, link: bigint): LockTerms => ({ role: ROLE_LP, market: pool, t2: side, t3: bound, t4: link });

/** Both locks of an LP add, committing the band [lo, hi] the add runs in. lo = 0 or hi = PRICE_NO_UPPER leaves that side open. */
export function lpBandTerms(pool: bigint, link: bigint, lo: bigint, hi: bigint): [LockTerms, LockTerms] {
  assertBand(lo, hi);
  return [lpTerms(pool, 0n, lo, link), lpTerms(pool, 1n, hi, link)];
}

export function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: bigint): bigint {
  if (reserveIn === 0n || reserveOut === 0n) return 0n;
  const withFee = amountIn * (BPS - feeBps);
  return (withFee * reserveOut) / (reserveIn * BPS + withFee);
}

export function floorSqrt(x: bigint): bigint {
  if (x < 0n) throw new RangeError("square root of a negative number");
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
  /** Protocol's share of swap fees, held beside the reserves but never counted as them. */
  readonly proto0: bigint;
  readonly proto1: bigint;
  readonly blind: bigint;
}

export const EMPTY_POOL: PoolState = { r0: 0n, r1: 0n, supply: 0n, lastLeaf: 0n, proto0: 0n, proto1: 0n, blind: 0n };

export interface PoolInfo {
  readonly id: bigint;
  readonly token0: bigint;
  readonly token1: bigint;
  readonly feeBps: bigint;
  /** Share of each swap fee, in bps of the fee, that accrues to the protocol. Set by governance, 0 by default. */
  readonly protocolBps: bigint;
  readonly state: PoolState;
  /** On-chain commitment; zero until the pool is seeded. */
  readonly head: bigint;
}

const statePlain = (s: PoolState): bigint[] => [s.r0, s.r1, s.supply, s.lastLeaf, s.proto0, s.proto1, s.blind];
const stateInput = (s: PoolState): InputValue => ({
  r0: f(s.r0), r1: f(s.r1), supply: f(s.supply), last_leaf: f(s.lastLeaf), proto0: f(s.proto0), proto1: f(s.proto1), blind: f(s.blind),
});

export function poolHead(deployment: bigint, pool: bigint, s: PoolState): bigint {
  return hash([T_POOL, deployment, RECORD_VERSION, pool, ...statePlain(s)]);
}

export function openPoolState(ct: readonly bigint[], sk: bigint): PoolState {
  const [r0, r1, supply, lastLeaf, proto0, proto1, blind] = decrypt(ct, sk, POOL_PT_LEN) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  return { r0, r1, supply, lastLeaf, proto0, proto1, blind };
}

export interface LpRecord {
  readonly pool: bigint;
  readonly shares: bigint;
  readonly ownerAuth: bigint;
  readonly ownerX: bigint;
  readonly ownerY: bigint;
  /** 0 while idle; otherwise the removal request's expiry, which runs only while the pool price is in [priceLo, priceHi]. */
  readonly expiry: bigint;
  readonly priceLo: bigint;
  readonly priceHi: bigint;
  readonly recNonce: bigint;
  readonly blind: bigint;
}

const lpPlain = (l: LpRecord): bigint[] => [l.pool, l.shares, l.ownerAuth, l.ownerX, l.ownerY, l.expiry, l.priceLo, l.priceHi, l.recNonce, l.blind];
const lpInput = (l: LpRecord): InputValue => ({
  pool: f(l.pool), shares: f(l.shares), owner_auth: f(l.ownerAuth), owner_x: f(l.ownerX), owner_y: f(l.ownerY), expiry: f(l.expiry), price_lo: f(l.priceLo), price_hi: f(l.priceHi),
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
  const [pool, shares, ownerAuth, ownerX, ownerY, expiry, priceLo, priceHi, recNonce, blind] = pt as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  const l: LpRecord = { pool, shares, ownerAuth, ownerX, ownerY, expiry, priceLo, priceHi, recNonce, blind };
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

const ZERO_CT: readonly bigint[] = Array.from({ length: POOL_CT_LEN }, () => 0n);

/** lib.nr `protocol_cut`: the protocol's part of a swap fee, rounded down, taken out of the input reserve. */
export function protocolCut(amountIn: bigint, feeBps: bigint, protocolBps: bigint): bigint {
  if (protocolBps < 0n || protocolBps > BPS) throw new RangeError("protocol share above BPS");
  return (amountIn * feeBps * protocolBps) / (BPS * BPS);
}

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
    const cut = protocolCut(amount, p.feeBps, p.protocolBps);
    const rInNext = rIn + amount - cut;
    const [r0, r1] = zeroForOne ? [rInNext, rOut - out] : [rOut - out, rInNext];
    const [proto0, proto1] = zeroForOne ? [p.state.proto0 + cut, p.state.proto1] : [p.state.proto0, p.state.proto1 + cut];
    next.push({ r0, r1, supply: p.state.supply, lastLeaf: leaf, proto0, proto1, blind: randomField() });
    amount = out;
    asset = zeroForOne ? p.token1 : p.token0;
  }
  const built = next.map((s, i) => nextPool(r.deployment, r.pools[i]!.id, s, r.keys));
  const second: PoolInfo = r.pools[1] ?? { id: 0n, token0: 0n, token1: 0n, feeBps: 0n, protocolBps: 0n, state: EMPTY_POOL, head: 0n };
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
      fee_bps: [f(r.pools[0].feeBps), f(second.feeBps)], protocol_bps: [f(r.pools[0].protocolBps), f(second.protocolBps)], head: [f(r.pools[0].head), f(second.head)], new_head: heads.map(f),
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
  // lockPair writes the two locks at adjacent leaves; any other placement can never be added and refunds at expiry.
  if (r.lock1.leafIndex !== r.lock0.leafIndex + 1) throw new Error("LP locks not adjacent");
  const outcome = lpAddOutcome(a.amount, b.amount, r.pool.state);
  const nf0 = recNullifier(lockCommitment(r.deployment, a), a.recNonce);
  const nf1 = recNullifier(lockCommitment(r.deployment, b), b.recNonce);
  const leaf = BigInt(r.lock1.leafIndex) + 1n;
  const s = r.pool.state;
  const next: PoolState = { ...s, r0: s.r0 + outcome.used0, r1: s.r1 + outcome.used1, supply: outcome.supply, lastLeaf: leaf, blind: randomField() };
  const built = nextPool(r.deployment, r.pool.id, next, r.keys);
  const salt = randomField();
  const record: LpRecord = {
    pool: r.pool.id, shares: outcome.shares, ownerAuth: a.ownerAuth, ownerX: a.ownerX, ownerY: a.ownerY, expiry: 0n, priceLo: 0n, priceHi: 0n,
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

/**
 * Mode 0: the owner opens a removal request that runs only while the pool price is in [priceLo, priceHi]. Mode 1: anyone
 * returns an expired request to idle (sk and the band unused).
 */
export function lpSetWitness(r: {
  readonly claim: LpRecord;
  readonly leafIndex: number;
  readonly deployment: bigint;
  readonly tree: MerkleTree;
  readonly mode: bigint;
  readonly sk: bigint;
  readonly priceLo: bigint;
  readonly priceHi: bigint;
  readonly expiry: bigint;
  readonly asOf: bigint;
  readonly keys: readonly [Point, Point, Point];
}): { inputs: InputMap; publicInputs: LpSetPublic; record: LpRecord } {
  const c = r.claim;
  const nf = recNullifier(lpCommitment(r.deployment, c), c.recNonce);
  const salt = randomField();
  const opening = r.mode === 0n;
  if (opening) assertBand(r.priceLo, r.priceHi);
  const record: LpRecord = {
    ...c, expiry: opening ? r.expiry : 0n, priceLo: opening ? r.priceLo : 0n, priceHi: opening ? r.priceHi : 0n, recNonce: deriveRecNonce(nf, 0n, 0n, salt), blind: randomField(),
  };
  const recipients = [{ x: c.ownerX, y: c.ownerY }, ...r.keys];
  const eph = recipients.map(() => randomField());
  const cts = recipients.map((k, i) => encrypt(lpPlain(record), k, eph[i]!));
  const cm = lpCommitment(r.deployment, record);
  const root = r.tree.root();
  return {
    record,
    inputs: {
      claim: lpInput(c), index: f(BigInt(r.leafIndex)), path: r.tree.path(r.leafIndex).map(f), sk: f(r.sk), price_lo: f(r.priceLo), price_hi: f(r.priceHi), expiry: f(r.expiry), salt: f(salt), new_blind: f(record.blind), eph: eph.map(f),
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
  const next: PoolState = { ...s, r0: s.r0 - out0, r1: s.r1 - out1, supply: s.supply - c.shares, lastLeaf: BigInt(r.leafIndex) + 1n, blind: randomField() };
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

export interface SweepProtocolPublic {
  readonly pool: bigint;
  readonly newHead: Hex;
  readonly outCommitments: readonly [Hex, Hex];
  readonly outCt: readonly (readonly Hex[])[];
  readonly poolCt: readonly (readonly Hex[])[];
}

/**
 * Pays a pool's protocol accruals to the deployment fee address as two FREE notes and zeroes them. Reserves, supply and
 * `lastLeaf` don't move, so a sweep never strands an intent. Any pool-key holder can build it.
 */
export function sweepProtocolWitness(r: {
  readonly pool: PoolInfo;
  readonly deployment: bigint;
  readonly feeTo: PrivateAddress;
  readonly keys: readonly [Point, Point, Point];
}): { inputs: InputMap; publicInputs: SweepProtocolPublic; next: PoolState; paid: readonly [bigint, bigint] } {
  const s = r.pool.state;
  if (s.proto0 === 0n && s.proto1 === 0n) throw new Error("nothing to sweep");
  const next: PoolState = { ...s, proto0: 0n, proto1: 0n, blind: randomField() };
  const built = nextPool(r.deployment, r.pool.id, next, r.keys);
  const outs = [
    noteOutput(r.deployment, r.pool.token0, s.proto0, outputRho(r.pool.head, built.head, 0), r.feeTo),
    noteOutput(r.deployment, r.pool.token1, s.proto1, outputRho(r.pool.head, built.head, 1), r.feeTo),
  ];
  return {
    next,
    paid: [s.proto0, s.proto1],
    inputs: {
      state: stateInput(s), new_blind: f(next.blind), out_blind: outs.map((x) => f(x.blind)), out_eph: outs.map((x) => f(x.eph)), pool_eph: built.eph.map(f),
      head: f(r.pool.head), new_head: f(built.head), cm_out: outs.map((x) => f(x.commitment)), ct_out: outs.map((x) => x.ct.map(f)), ct_pool: built.cts.map((c) => c.map(f)),
      deployment: f(r.deployment), pool: f(r.pool.id), token0: f(r.pool.token0), token1: f(r.pool.token1),
      fee_auth: f(r.feeTo.auth), fee_pk: [f(r.feeTo.pk.x), f(r.feeTo.pk.y)], keys: flat(r.keys),
    },
    publicInputs: {
      pool: r.pool.id, newHead: toHex32(built.head), outCommitments: [toHex32(outs[0]!.commitment), toHex32(outs[1]!.commitment)],
      outCt: outs.map((x) => x.ct.map(toHex32)), poolCt: built.cts.map((c) => c.map(toHex32)),
    },
  };
}

// Price bands (M36 spot #1). Prices are P = r1 * WAD / r0: WAD-scaled token1 base units per token0 base unit. An LP add
// commits [lo, hi] in its two locks' t3, and a removal request commits it in the claim; the circuits check the pool price
// against it by cross-multiplication, exact at both edges. Either edge may be open: lo = 0 has no lower bound and
// hi = PRICE_NO_UPPER no upper bound.

/** A band's low edge with no lower bound. */
export const PRICE_NO_LOWER = 0n;
/** A band's high edge with no upper bound: the largest value a 128-bit band edge holds. */
export const PRICE_NO_UPPER = (1n << PRICE_BAND_BITS) - 1n;

function assertBand(lo: bigint, hi: bigint): void {
  if (lo < PRICE_NO_LOWER) throw new RangeError("negative band");
  if (hi === 0n) throw new RangeError("empty band");
  if (hi < lo) throw new RangeError("inverted band");
  if (hi > PRICE_NO_UPPER) throw new RangeError("band above 128 bits");
}

/** The pool's price, rounded down. Display only: compare against a band with `inBand`. */
export function poolPriceWad(r0: bigint, r1: bigint): bigint {
  if (r0 === 0n) throw new RangeError("empty pool");
  return (r1 * WAD) / r0;
}

/** lib.nr `assert_price_in_band`: lo <= r1 * WAD / r0 <= hi, exactly, with PRICE_NO_UPPER as no upper bound. */
export function inBand(r0: bigint, r1: bigint, lo: bigint, hi: bigint): boolean {
  return r1 * WAD >= lo * r0 && (hi === PRICE_NO_UPPER || hi * r0 >= r1 * WAD);
}

/** The price an LP add is checked at: the depositor's own ratio on an unseeded pool, the pool's otherwise. */
export function lpAddPrice(d0: bigint, d1: bigint, s: PoolState): readonly [bigint, bigint] {
  return s.supply === 0n ? [d0, d1] : [s.r0, s.r1];
}

/** token1 base units per token0 base unit, as a fraction. */
export interface Price {
  readonly num: bigint;
  readonly den: bigint;
}

/** The range the pool's pre-trade mid price can be in, given a rounded quote. */
export interface PriceBand {
  readonly low: Price;
  readonly high: Price;
}

/** Quotes round amountOut down to four significant figures, so the true output is below amountOut * 1.001. */
const QUOTE_ROUNDING_PER_MILLE = 1_001n;

/** Below this many base units of output, the quote's rounding is too coarse to locate the price. */
export const MIN_QUOTE_OUT = 1_000n;

/**
 * The mid price behind a quote of `amountIn` token0 for `amountOut` token1. The quote's output is net of the pool fee
 * and of its price impact, which it reports in whole basis points rounded down, so both are undone here as a band. The
 * impact is read from reserves cut to four significant figures, which can understate it by about a thousandth of
 * itself, so the low edge comes down a further ceil(impact / 1000) + 1 bps.
 */
export function midPriceBand(amountIn: bigint, amountOut: bigint, feeBps: bigint, priceImpactBps: number): PriceBand | null {
  if (amountIn <= 0n || amountOut < MIN_QUOTE_OUT || !Number.isInteger(priceImpactBps) || priceImpactBps < 0 || priceImpactBps >= 9_999) return null;
  const impact = BigInt(priceImpactBps);
  const feeKept = BPS - feeBps;
  const impactSlack = ceilDiv(impact, 1_000n) + 1n;
  return {
    low: { num: amountOut * BPS * (BPS - impactSlack), den: amountIn * feeKept * (BPS - impact) },
    high: { num: amountOut * QUOTE_ROUNDING_PER_MILLE * BPS * BPS, den: 1_000n * amountIn * feeKept * (BPS - impact - 1n) },
  };
}

function checkSlippage(slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps <= 0 || slippageBps >= 10_000) throw new RangeError("slippage must be between 1 and 9999 bps");
  return BigInt(slippageBps);
}

/** Widens [lo, hi] by `slippageBps` on each side, rounding outward, and keeps lo at least 1. */
function widen(lo: bigint, hi: bigint, slippageBps: number): { lo: bigint; hi: bigint } {
  const s = checkSlippage(slippageBps);
  const wideLo = (lo * (BPS - s)) / BPS;
  const band = { lo: wideLo > 0n ? wideLo : 1n, hi: ceilDiv(hi * (BPS + s), BPS) };
  assertBand(band.lo, band.hi);
  return band;
}

/** The WAD band an LP add or removal commits, from a quote's mid-price band: floor the low edge, ceil the high, then widen. */
export function bandFromQuote(band: PriceBand, slippageBps: number): { lo: bigint; hi: bigint } {
  return widen((band.low.num * WAD) / band.low.den, ceilDiv(band.high.num * WAD, band.high.den), slippageBps);
}

/**
 * The band for a deposit into a pool with no quote, centred on the depositor's own ratio, which lp_add checks an unseeded
 * pool against. If someone else seeds the pool first at a price outside it, the add doesn't run and the locks refund.
 */
export function bandForDeposit(amount0: bigint, amount1: bigint, slippageBps: number): { lo: bigint; hi: bigint } {
  if (amount0 <= 0n || amount1 <= 0n) throw new RangeError("deposit amounts");
  return widen((amount1 * WAD) / amount0, ceilDiv(amount1 * WAD, amount0), slippageBps);
}

/**
 * What removing `shares` pays at least, at the edges of [lo, hi]. Display only. Every share is backed by at least one unit
 * of liquidity (sqrt(r0 * r1) / supply >= 1: the first mint is floor(sqrt(d0 * d1)), adds and removals round toward the
 * pool, swaps grow k), so at price P a share pays at least 1/sqrt(P) token0 and sqrt(P) token1. Token0 is lowest at hi and
 * token1 at lo, and an open edge promises none of that token.
 */
export function removalEstimate(shares: bigint, band: { readonly lo: bigint; readonly hi: bigint }): { out0: bigint; out1: bigint } {
  assertBand(band.lo, band.hi);
  return { out0: band.hi === PRICE_NO_UPPER ? 0n : floorSqrt((shares * shares * WAD) / band.hi), out1: floorSqrt((shares * shares * band.lo) / WAD) };
}
