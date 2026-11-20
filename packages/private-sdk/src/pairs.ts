import {
  ACTOR_MAKER, ACTOR_NONE, ACTOR_TAKER, AMOUNT_LIMIT, BPS, CLAIM_PT_LEN, CLOSE_MATURED, CLOSE_TAKER, FREE_DOMAIN, LOCK_PT_LEN, MAX_INTENT_LIFETIME, MAX_MAKER_LIFETIME, MIN_UPDATE_GAP, OI_BATCH, OI_CLOSE, OI_OPEN,
  OI_REDUCE, PAIR_PT_LEN, RECORD_VERSION, RELAY_RHO_CLOSE, RELAY_RHO_LOCK, RELAY_RHO_REDEEM, RELAY_RHO_RELEASE, RELAY_RHO_UPDATE, ROLE_MAKER, ROLE_TAKER, T_AUTH, T_CLAIM, T_LOCK, T_MARKET,
  T_NF_REC, T_NONCE, T_OI, T_OWNER, T_PAIR, T_TERMS, TAKER_GRACE, WAD,
} from "./constants.js";
import { hash, type Point } from "./crypto.js";
import { decrypt, encrypt } from "./encryption.js";
import { randomField, toHex32, type Hex } from "./field.js";
import { addressOf, ownerTag, type PrivateAddress, type WalletKeys } from "./keys.js";
import { noteCommitment, noteInner, outputRho, ownerNullifier, type OwnedNote } from "./note.js";
import type { MerkleTree } from "./tree.js";
import type { InputMap, InputValue } from "./witness.js";

const f = (x: bigint): string => toHex32(x);

// Fixed-point math, written from contracts/src/lib/RiskMath.sol. The circuits recompute all of it; a disagreement
// surfaces as a failed witness or a rejected proof.

export function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

export function notionalUp(size: bigint, price: bigint): bigint {
  return ceilDiv(size * price, WAD);
}

export function marginRequirement(size: bigint, price: bigint, fractionWad: bigint, scale: bigint): bigint {
  return ceilDiv(ceilDiv(notionalUp(size, price) * fractionWad, WAD), scale);
}

export function positionFee(size: bigint, price: bigint, feeBps: bigint, scale: bigint): bigint {
  return ceilDiv(ceilDiv(notionalUp(size, price) * feeBps, BPS), scale);
}

export interface PairPnl {
  readonly takerGains: boolean;
  /** Magnitude rounded down: the gaining side's health credit and the transfer amount. */
  readonly floor: bigint;
  /** Magnitude rounded up: the losing side's health debit. */
  readonly ceil: bigint;
}

export function pairPnl(isShort: bigint, size: bigint, entry: bigint, mark: bigint, scale: bigint): PairPnl {
  const up = mark >= entry;
  const raw = size * (up ? mark - entry : entry - mark);
  const d = WAD * scale;
  return { takerGains: up === (isShort === 0n), floor: raw / d, ceil: ceilDiv(raw, d) };
}

export function below(margin: bigint, gains: boolean, pnl: PairPnl, requirement: bigint): boolean {
  return gains ? margin + pnl.floor < requirement : margin < requirement + pnl.ceil;
}

export function fillPrice(mark: bigint, isShort: bigint, spreadBps: bigint): bigint {
  return isShort === 0n ? ceilDiv(mark * (BPS + spreadBps), BPS) : (mark * (BPS - spreadBps)) / BPS;
}

// Records. Field order mirrors `Lock` and `Pair` in zk/circuits/lib/src/lib.nr.

export function recNullifier(commitment: bigint, recNonce: bigint): bigint {
  return hash([T_NF_REC, commitment, recNonce]);
}

export function deriveRecNonce(nf0: bigint, nf1: bigint, index: bigint, salt: bigint): bigint {
  return hash([T_NONCE, nf0, nf1, index, salt]);
}

export interface LockTerms {
  readonly role: bigint;
  readonly market: bigint;
  readonly t2: bigint;
  readonly t3: bigint;
  readonly t4: bigint;
}

export const takerTerms = (market: bigint, isShort: boolean, size: bigint, limitPrice: bigint): LockTerms =>
  ({ role: ROLE_TAKER, market, t2: isShort ? 1n : 0n, t3: size, t4: limitPrice });

export const makerTerms = (market: bigint, spreadBps: bigint, maxSize: bigint, closeSpreadBps: bigint): LockTerms =>
  ({ role: ROLE_MAKER, market, t2: spreadBps, t3: maxSize, t4: closeSpreadBps });

export interface LockRecord extends LockTerms {
  readonly asset: bigint;
  readonly amount: bigint;
  readonly ownerAuth: bigint;
  readonly ownerX: bigint;
  readonly ownerY: bigint;
  readonly expiry: bigint;
  readonly recNonce: bigint;
  readonly blind: bigint;
}

export function lockCommitment(deployment: bigint, l: LockRecord): bigint {
  const terms = hash([T_TERMS, l.role, l.market, l.t2, l.t3, l.t4]);
  return hash([T_LOCK, deployment, RECORD_VERSION, l.asset, l.amount, l.ownerAuth, l.ownerX, l.ownerY, terms, l.expiry, l.recNonce, l.blind]);
}

const lockPlaintext = (l: LockRecord): bigint[] =>
  [l.asset, l.amount, l.ownerAuth, l.ownerX, l.ownerY, l.role, l.market, l.t2, l.t3, l.t4, l.expiry, l.recNonce, l.blind];

function lockFromPlaintext(p: readonly bigint[]): LockRecord {
  const [asset, amount, ownerAuth, ownerX, ownerY, role, market, t2, t3, t4, expiry, recNonce, blind] = p as [
    bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint,
  ];
  return { asset, amount, ownerAuth, ownerX, ownerY, role, market, t2, t3, t4, expiry, recNonce, blind };
}

export const lockInput = (l: LockRecord): InputValue => ({
  asset: f(l.asset), amount: f(l.amount), owner_auth: f(l.ownerAuth), owner_x: f(l.ownerX), owner_y: f(l.ownerY),
  role: f(l.role), market: f(l.market), t2: f(l.t2), t3: f(l.t3), t4: f(l.t4), expiry: f(l.expiry),
  rec_nonce: f(l.recNonce), blind: f(l.blind),
});

export interface PairRecord {
  readonly market: bigint;
  readonly asset: bigint;
  readonly isShort: bigint;
  readonly size: bigint;
  readonly entry: bigint;
  readonly fundingIndex: bigint;
  readonly closeSpread: bigint;
  readonly fundingDebt: bigint;
  readonly debtByTaker: bigint;
  readonly lastReduce: bigint;
  /** When this version was created; the next update waits `minGap` from here unless it is a cure. */
  readonly updatedAt: bigint;
  readonly takerMargin: bigint;
  readonly makerMargin: bigint;
  readonly takerAuth: bigint;
  readonly takerX: bigint;
  readonly takerY: bigint;
  readonly makerAuth: bigint;
  readonly makerX: bigint;
  readonly makerY: bigint;
  readonly recNonce: bigint;
  readonly blind: bigint;
}

const pairPlaintext = (p: PairRecord): bigint[] => [
  p.market, p.asset, p.isShort, p.size, p.entry, p.fundingIndex, p.closeSpread, p.fundingDebt, p.debtByTaker, p.lastReduce, p.updatedAt, p.takerMargin, p.makerMargin, p.takerAuth, p.takerX, p.takerY,
  p.makerAuth, p.makerX, p.makerY, p.recNonce, p.blind,
];

export function pairCommitment(deployment: bigint, p: PairRecord): bigint {
  return hash([T_PAIR, deployment, RECORD_VERSION, ...pairPlaintext(p)]);
}

function pairFromPlaintext(pt: readonly bigint[]): PairRecord {
  const [market, asset, isShort, size, entry, fundingIndex, closeSpread, fundingDebt, debtByTaker, lastReduce, updatedAt, takerMargin, makerMargin, takerAuth, takerX, takerY, makerAuth, makerX, makerY, recNonce, blind] = pt as [
    bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint,
  ];
  return { market, asset, isShort, size, entry, fundingIndex, closeSpread, fundingDebt, debtByTaker, lastReduce, updatedAt, takerMargin, makerMargin, takerAuth, takerX, takerY, makerAuth, makerX, makerY, recNonce, blind };
}

const pairInput = (p: PairRecord): InputValue => ({
  market: f(p.market), asset: f(p.asset), is_short: f(p.isShort), size: f(p.size), entry: f(p.entry), funding_index: f(p.fundingIndex), close_spread: f(p.closeSpread), funding_debt: f(p.fundingDebt), debt_by_taker: f(p.debtByTaker), last_reduce: f(p.lastReduce),
  updated_at: f(p.updatedAt), taker_margin: f(p.takerMargin), maker_margin: f(p.makerMargin), taker_auth: f(p.takerAuth), taker_x: f(p.takerX),
  taker_y: f(p.takerY), maker_auth: f(p.makerAuth), maker_x: f(p.makerX), maker_y: f(p.makerY),
  rec_nonce: f(p.recNonce), blind: f(p.blind),
});

/**
 * Opens a ciphertext and accepts it only if the plaintext rebuilds the on-chain commitment. Returns null for
 * anything else, so a corrupt or foreign ciphertext is ignored rather than trusted.
 */
export function openLock(ct: readonly bigint[], encSk: bigint, deployment: bigint, commitment: bigint): LockRecord | null {
  const l = lockFromPlaintext(decryptOrNull(ct, encSk, LOCK_PT_LEN) ?? []);
  return l.asset !== undefined && lockCommitment(deployment, l) === commitment ? l : null;
}

export function openPair(ct: readonly bigint[], encSk: bigint, deployment: bigint, commitment: bigint): PairRecord | null {
  const p = pairFromPlaintext(decryptOrNull(ct, encSk, PAIR_PT_LEN) ?? []);
  return p.market !== undefined && pairCommitment(deployment, p) === commitment ? p : null;
}

function decryptOrNull(ct: readonly bigint[], encSk: bigint, len: number): bigint[] | null {
  try {
    return decrypt(ct, encSk, len);
  } catch (err) {
    if (err instanceof Error && /Grumpkin point|ciphertext length/.test(err.message)) return null;
    throw err;
  }
}

/** Who a relay fee note pays and how much. */
export interface RelayFee {
  readonly value: bigint;
  readonly to: PrivateAddress;
}

/** The relay fee output as the contract takes it (`FeeOut`): one more FREE leaf per action. */
export interface FeeOut {
  readonly commitment: Hex;
  readonly ct: readonly Hex[];
}

/**
 * Zero fee to the wallet's own address. A zero note is a real encryption to a real key, so it can't be told apart from a
 * paid one on chain, and the relayer's scanner never sees dust.
 */
export const zeroRelayFee = (self: PrivateAddress): RelayFee => ({ value: 0n, to: self });

/**
 * Builds the relay fee note every relayed action carries (lib.nr `RelayFee`), with rho = output_rho(nf0, nf1, index).
 * The caller still deducts `fee.value` from what the prover is entitled to.
 */
export function relayFeeNote(deployment: bigint, asset: bigint, nf0: bigint, nf1: bigint, index: number, fee: RelayFee): { input: InputValue; out: FeeOut; value: bigint } {
  if (fee.value < 0n || fee.value >= AMOUNT_LIMIT) throw new RangeError("relay fee out of range");
  const note = noteOutput(deployment, asset, fee.value, outputRho(nf0, nf1, index), fee.to);
  return {
    value: fee.value,
    input: { value: f(fee.value), auth: f(fee.to.auth), pk: { x: f(fee.to.pk.x), y: f(fee.to.pk.y) }, blind: f(note.blind), eph: f(note.eph) },
    out: { commitment: toHex32(note.commitment), ct: note.ct.map(toHex32) },
  };
}

/** On a path the circuit lets anyone prove from the plaintext, a nonzero fee needs the owner's key. */
function requireOwnerKeyForFee(fee: RelayFee, sk: bigint | undefined, ownerAuth: bigint): void {
  if (fee.value !== 0n && (sk === undefined || hash([T_AUTH, sk]) !== ownerAuth)) throw new Error("fee needs the owner key");
}

/** Replaces a missing second input with a zero-value dummy owned by the spender. */
function padInputs(keys: WalletKeys, deployment: bigint, asset: bigint, inputs: readonly OwnedNote[]): [OwnedNote, OwnedNote] {
  if (inputs.length < 1 || inputs.length > 2) throw new RangeError("one or two input notes");
  for (const n of inputs) if (n.asset !== asset) throw new Error("input note of another asset");
  if (inputs.length === 2) return [inputs[0]!, inputs[1]!];
  const rho = randomField();
  const blind = randomField();
  const cm = noteCommitment(deployment, asset, 0n, noteInner(keys.owner, rho, blind));
  return [inputs[0]!, { leafIndex: 0, asset, value: 0n, rho, blind, commitment: cm, nullifier: ownerNullifier(keys.nk, cm) }];
}

export interface LockPublic {
  readonly root: Hex;
  readonly nullifiers: readonly [Hex, Hex];
  readonly changeCommitment: Hex;
  readonly lockCommitment: Hex;
  readonly changeCt: readonly Hex[];
  readonly ownerCt: readonly Hex[];
  readonly coordinatorCt: readonly Hex[];
  readonly riskCt: readonly (readonly Hex[])[];
  readonly asOf: bigint;
  readonly relayFee: FeeOut;
}

export function lockWitness(r: {
  readonly keys: WalletKeys;
  readonly deployment: bigint;
  readonly tree: MerkleTree;
  readonly asset: bigint;
  readonly inputs: readonly OwnedNote[];
  readonly amount: bigint;
  readonly terms: LockTerms;
  readonly expiry: bigint;
  readonly coordinator: Point;
  /** Both risk keys from the contract, so a worker can execute or refund this lock if the coordinator is gone. */
  readonly riskKeys: readonly [Point, Point];
  /** One-time address the position pays out to (`lockAddressKeys`). */
  readonly payout: PrivateAddress;
  /** The wallet's main key: its own copy of the lock is encrypted here so restore can find it. */
  readonly view: Point;
  /** Latest block time; the contract refuses one in the future. Expiry may be at most `as_of` plus the role's lifetime. */
  readonly asOf: bigint;
  /** [intent cap, maker cap] as the contract supplies them. */
  readonly maxLifetime?: readonly [bigint, bigint];
  /** Defaults to zero to the wallet's own address. */
  readonly relayFee?: RelayFee;
}): { inputs: InputMap; publicInputs: LockPublic; record: LockRecord } {
  const maxLifetime = r.maxLifetime ?? [MAX_INTENT_LIFETIME, MAX_MAKER_LIFETIME];
  if (r.expiry > r.asOf + (r.terms.role === ROLE_MAKER ? maxLifetime[1] : maxLifetime[0])) throw new RangeError("lock lifetime");
  const fee = r.relayFee ?? zeroRelayFee(addressOf(r.keys));
  const ins = padInputs(r.keys, r.deployment, r.asset, r.inputs);
  const total = ins[0].value + ins[1].value;
  if (r.amount <= 0n || r.amount + fee.value > total) throw new RangeError("lock amount");
  const changeValue = total - r.amount - fee.value;
  const [nf0, nf1] = [ins[0].nullifier, ins[1].nullifier];
  const salt = randomField();
  const record: LockRecord = {
    ...r.terms, asset: r.asset, amount: r.amount, ownerAuth: r.payout.auth, ownerX: r.payout.pk.x, ownerY: r.payout.pk.y,
    expiry: r.expiry, recNonce: deriveRecNonce(nf0, nf1, 1n, salt), blind: randomField(),
  };
  const rho = outputRho(nf0, nf1, 0);
  const changeBlind = randomField();
  const changeEph = randomField();
  const cmChange = noteCommitment(r.deployment, r.asset, changeValue, noteInner(r.keys.owner, rho, changeBlind));
  const cmLock = lockCommitment(r.deployment, record);
  const ctChange = encrypt([FREE_DOMAIN, r.asset, changeValue, rho, changeBlind], r.keys.pk, changeEph);
  const relay = relayFeeNote(r.deployment, r.asset, nf0, nf1, RELAY_RHO_LOCK, fee);
  const [ephOwner, ephCoordinator] = [randomField(), randomField()];
  const ctOwner = encrypt(lockPlaintext(record), r.view, ephOwner);
  const ctCoordinator = encrypt(lockPlaintext(record), r.coordinator, ephCoordinator);
  const ephRisk = r.riskKeys.map(() => randomField());
  const ctRisk = r.riskKeys.map((k, i) => encrypt(lockPlaintext(record), k, ephRisk[i]!));
  const zeroPath = Array.from({ length: r.tree.depth }, () => f(0n));
  const root = r.tree.root();
  return {
    record,
    inputs: {
      sk: f(r.keys.sk),
      own_pk: { x: f(r.keys.pk.x), y: f(r.keys.pk.y) },
      asset: f(r.asset),
      ins: ins.map((n) => ({ value: f(n.value), rho: f(n.rho), blind: f(n.blind), index: f(BigInt(n.leafIndex)), path: n.value === 0n ? zeroPath : r.tree.path(n.leafIndex).map(f) })),
      change: { value: f(changeValue), blind: f(changeBlind), eph: f(changeEph) },
      lock: {
        payout_auth: f(r.payout.auth), payout_pk: { x: f(r.payout.pk.x), y: f(r.payout.pk.y) }, view_pk: { x: f(r.view.x), y: f(r.view.y) },
        amount: f(r.amount), role: f(record.role), market: f(record.market), t2: f(record.t2), t3: f(record.t3), t4: f(record.t4),
        expiry: f(record.expiry), salt: f(salt), blind: f(record.blind), eph_owner: f(ephOwner), eph_coordinator: f(ephCoordinator), eph_risk: ephRisk.map(f),
      },
      root: f(root),
      nf: [f(nf0), f(nf1)],
      cm_change: f(cmChange),
      cm_lock: f(cmLock),
      ct_change: ctChange.map(f),
      ct_owner: ctOwner.map(f),
      ct_coordinator: ctCoordinator.map(f),
      deployment: f(r.deployment),
      coordinator_pk: [f(r.coordinator.x), f(r.coordinator.y)],
      ct_risk: ctRisk.map((c) => c.map(f)),
      risk_pk: r.riskKeys.map((k) => [f(k.x), f(k.y)]),
      relay: relay.input,
      as_of: f(r.asOf),
      max_lifetime: maxLifetime.map(f),
      cm_relay: relay.out.commitment,
      ct_relay: [...relay.out.ct],
    },
    publicInputs: {
      root: toHex32(root),
      nullifiers: [toHex32(nf0), toHex32(nf1)],
      changeCommitment: toHex32(cmChange),
      lockCommitment: toHex32(cmLock),
      changeCt: ctChange.map(toHex32),
      ownerCt: ctOwner.map(toHex32),
      coordinatorCt: ctCoordinator.map(toHex32),
      riskCt: ctRisk.map((c) => c.map(toHex32)),
      asOf: r.asOf,
      relayFee: relay.out,
    },
  };
}

export interface HeldLock {
  readonly record: LockRecord;
  readonly leafIndex: number;
}

export interface ReleasePublic {
  readonly root: Hex;
  readonly nullifier: Hex;
  readonly commitment: Hex;
  readonly ciphertext: readonly Hex[];
  readonly asOf: bigint;
  readonly relayFee: FeeOut;
}

/**
 * Refunds an expired lock. Anyone holding the plaintext can prove it with a zero fee; a nonzero fee needs `sk`, the lock's
 * one-time key (`lockAddressKeys`). The fee defaults to zero to the lock's own payout address.
 */
export function releaseWitness(r: {
  readonly held: HeldLock;
  readonly deployment: bigint;
  readonly tree: MerkleTree;
  readonly asOf: bigint;
  readonly sk?: bigint;
  readonly relayFee?: RelayFee;
}): { inputs: InputMap; publicInputs: ReleasePublic; value: bigint } {
  const l = r.held.record;
  const self: PrivateAddress = { auth: l.ownerAuth, pk: { x: l.ownerX, y: l.ownerY } };
  const fee = r.relayFee ?? zeroRelayFee(self);
  requireOwnerKeyForFee(fee, r.sk, l.ownerAuth);
  if (fee.value > l.amount) throw new RangeError("fee above available");
  const value = l.amount - fee.value;
  const nf = recNullifier(lockCommitment(r.deployment, l), l.recNonce);
  const out = noteOutput(r.deployment, l.asset, value, outputRho(nf, 0n, 0), self);
  const relay = relayFeeNote(r.deployment, l.asset, nf, 0n, RELAY_RHO_RELEASE, fee);
  const root = r.tree.root();
  return {
    value,
    inputs: {
      lock: lockInput(l), index: f(BigInt(r.held.leafIndex)), path: r.tree.path(r.held.leafIndex).map(f), blind: f(out.blind), eph: f(out.eph), sk: f(r.sk ?? 0n), relay: relay.input,
      root: f(root), nf: f(nf), cm_out: f(out.commitment), ct: out.ct.map(f), deployment: f(r.deployment), now: f(r.asOf), cm_relay: relay.out.commitment, ct_relay: [...relay.out.ct],
    },
    publicInputs: { root: toHex32(root), nullifier: toHex32(nf), commitment: toHex32(out.commitment), ciphertext: out.ct.map(toHex32), asOf: r.asOf, relayFee: relay.out },
  };
}

export interface OpenPublic {
  readonly root: Hex;
  readonly nullifiers: readonly [Hex, Hex];
  readonly pairCommitment: Hex;
  readonly refundCommitment: Hex;
  readonly pairCt: readonly (readonly Hex[])[];
  readonly refundCt: readonly Hex[];
  readonly market: bigint;
  readonly asOf: bigint;
  readonly deltaCommitment: Hex;
  readonly feeCommitment: Hex;
  readonly feeCt: readonly Hex[];
}

/** Market parameters and last folded state that open_pair checks against. */
export interface OpenLimits {
  readonly feeBps: bigint;
  readonly feeTo: PrivateAddress;
  readonly head: bigint;
  readonly state: MarketState;
  readonly oiPending: bigint;
  readonly maxOiUsd: bigint;
  readonly maxPairSize: bigint;
  /** Market cap on the maker's standing close spread, in bps. */
  readonly maxCloseSpread: bigint;
}

/** `kind` is OI_OPEN, OI_CLOSE (close and liquidation) or OI_REDUCE. */
export function oiDeltaCommitment(deployment: bigint, market: bigint, isShort: bigint, size: bigint, kind: bigint, recNonce: bigint, insIn = 0n, claim = 0n): bigint {
  return hash([T_OI, deployment, market, isShort, size, kind, insIn, claim, recNonce]);
}

export function openPairWitness(r: {
  readonly taker: HeldLock;
  readonly maker: HeldLock;
  readonly makerMargin: bigint;
  readonly deployment: bigint;
  readonly tree: MerkleTree;
  readonly mark: bigint;
  readonly asOf: bigint;
  readonly imrWad: bigint;
  readonly scale: bigint;
  readonly riskKeys: readonly [Point, Point];
  readonly fundingIndex: bigint;
  readonly limits: OpenLimits;
}): { inputs: InputMap; publicInputs: OpenPublic; record: PairRecord; fee: bigint } {
  const [t, m] = [r.taker.record, r.maker.record];
  const fill = fillPrice(r.mark, t.t2, m.t2);
  const takerFee = positionFee(t.t3, fill, r.limits.feeBps, r.scale);
  const nf0 = recNullifier(lockCommitment(r.deployment, t), t.recNonce);
  const nf1 = recNullifier(lockCommitment(r.deployment, m), m.recNonce);
  const salt = randomField();
  const record: PairRecord = {
    market: t.market, asset: t.asset, isShort: t.t2, size: t.t3, entry: fill, fundingIndex: r.fundingIndex, closeSpread: m.t4, fundingDebt: 0n, debtByTaker: 0n, lastReduce: 0n, updatedAt: r.asOf,
    takerMargin: t.amount - takerFee, makerMargin: r.makerMargin, takerAuth: t.ownerAuth, takerX: t.ownerX, takerY: t.ownerY,
    makerAuth: m.ownerAuth, makerX: m.ownerX, makerY: m.ownerY, recNonce: deriveRecNonce(nf0, nf1, 0n, salt), blind: randomField(),
  };
  const cmPair = pairCommitment(r.deployment, record);
  const keys: Point[] = [{ x: t.ownerX, y: t.ownerY }, { x: m.ownerX, y: m.ownerY }, r.riskKeys[0], r.riskKeys[1]];
  const ephs = keys.map(() => randomField());
  const pt = pairPlaintext(record);
  const ctPair = keys.map((k, i) => encrypt(pt, k, ephs[i]!));
  const refund = m.amount - r.makerMargin;
  const rho = outputRho(nf0, nf1, 1);
  const [refundBlind, refundEph] = [randomField(), randomField()];
  const makerOwner = hash([T_OWNER, m.ownerAuth, m.ownerX, m.ownerY]);
  const cmRefund = noteCommitment(r.deployment, m.asset, refund, noteInner(makerOwner, rho, refundBlind));
  const ctRefund = encrypt([FREE_DOMAIN, m.asset, refund, rho, refundBlind], keys[1]!, refundEph);
  const root = r.tree.root();
  const delta = oiDeltaCommitment(r.deployment, t.market, t.t2, t.t3, OI_OPEN, record.recNonce);
  const feeNote = noteOutput(r.deployment, t.asset, takerFee, outputRho(nf0, nf1, 2), r.limits.feeTo);
  const held = (h: HeldLock): InputValue => ({ lock: lockInput(h.record), index: f(BigInt(h.leafIndex)), path: r.tree.path(h.leafIndex).map(f) });
  return {
    record,
    inputs: {
      taker: held(r.taker), maker: held(r.maker), maker_margin: f(r.makerMargin), pair_salt: f(salt), pair_blind: f(record.blind),
      pair_eph: ephs.map(f), refund_blind: f(refundBlind), refund_eph: f(refundEph),
      root: f(root), nf: [f(nf0), f(nf1)], cm_pair: f(cmPair), cm_refund: f(cmRefund), ct_pair: ctPair.map((c) => c.map(f)), ct_refund: ctRefund.map(f),
      deployment: f(r.deployment), market: f(t.market), asset: f(t.asset), mark: f(r.mark), now: f(r.asOf), imr_wad: f(r.imrWad), scale: f(r.scale),
      risk_pk: r.riskKeys.map((k) => [f(k.x), f(k.y)]), funding_index: f(r.fundingIndex), delta_cm: f(delta),
      fee_blind: f(feeNote.blind), fee_eph: f(feeNote.eph), long_oi: f(r.limits.state.longOi), short_oi: f(r.limits.state.shortOi), head_insurance: f(r.limits.state.insurance), head_bad_debt: f(r.limits.state.badDebt), head_bond_used: f(r.limits.state.bondUsed), head_blind: f(r.limits.state.blind),
      cm_fee: f(feeNote.commitment), ct_fee: feeNote.ct.map(f), fee_bps: f(r.limits.feeBps), fee_auth: f(r.limits.feeTo.auth), fee_pk: [f(r.limits.feeTo.pk.x), f(r.limits.feeTo.pk.y)],
      head: f(r.limits.head), oi_pending: f(r.limits.oiPending), max_oi_usd: f(r.limits.maxOiUsd), max_pair_size: f(r.limits.maxPairSize),
      max_close_spread: f(r.limits.maxCloseSpread),
    },
    fee: takerFee,
    publicInputs: {
      root: toHex32(root), nullifiers: [toHex32(nf0), toHex32(nf1)], pairCommitment: toHex32(cmPair), refundCommitment: toHex32(cmRefund),
      pairCt: ctPair.map((c) => c.map(toHex32)), refundCt: ctRefund.map(toHex32), market: t.market, asOf: r.asOf, deltaCommitment: toHex32(delta), feeCommitment: toHex32(feeNote.commitment), feeCt: feeNote.ct.map(toHex32),
    },
  };
}

export function noteOutput(deployment: bigint, asset: bigint, value: bigint, rho: bigint, to: PrivateAddress) {
  const [blind, eph] = [randomField(), randomField()];
  return { blind, eph, commitment: noteCommitment(deployment, asset, value, noteInner(ownerTag(to), rho, blind)), ct: encrypt([FREE_DOMAIN, asset, value, rho, blind], to.pk, eph) };
}

/** What a liquidation pays, computed independently of the circuit. */
export interface LiquidationOutcome {
  readonly takerBad: boolean;
  readonly makerBad: boolean;
  readonly takerOut: bigint;
  readonly makerOut: bigint;
  readonly penalty: bigint;
  readonly reward: bigint;
  readonly toInsurance: bigint;
  /** Shortfall the winner claims; paid at the ratio of the epoch that folds it (D-07). */
  readonly claim: bigint;
  /** Private receipt fields (PERP-05, D-03). Positive `fundingOwed` magnitudes; `takerPaysFunding` gives direction. */
  readonly takerPaysFunding: boolean;
  readonly fundingOwed: bigint;
  readonly fundingPaid: bigint;
  readonly fundingNetted: bigint;
  readonly fundingWrittenOff: bigint;
}

const minOf = (a: bigint, b: bigint): bigint => (a < b ? a : b);

function settleFunding(p: PairRecord, fundingIndex: bigint, scale: bigint) {
  const indexUp = fundingIndex >= p.fundingIndex;
  const accrued = ceilDiv(p.size * (indexUp ? fundingIndex - p.fundingIndex : p.fundingIndex - fundingIndex), WAD * scale);
  const accruedByTaker = indexUp === (p.isShort === 0n);
  const debtByTaker = p.debtByTaker === 1n;
  let owed: bigint;
  let takerPays: boolean;
  if (accruedByTaker === debtByTaker) [owed, takerPays] = [accrued + p.fundingDebt, accruedByTaker];
  else if (p.fundingDebt < accrued) [owed, takerPays] = [accrued - p.fundingDebt, accruedByTaker];
  else [owed, takerPays] = [p.fundingDebt - accrued, debtByTaker];
  const fundingPaid = minOf(owed, takerPays ? p.takerMargin : p.makerMargin);
  return {
    owed, takerPays, fundingPaid, unpaid: owed - fundingPaid,
    takerMargin: takerPays ? p.takerMargin - fundingPaid : p.takerMargin + fundingPaid,
    makerMargin: takerPays ? p.makerMargin + fundingPaid : p.makerMargin - fundingPaid,
  };
}

export function liquidationOutcome(p: PairRecord, mark: bigint, mmrWad: bigint, penaltyBps: bigint, scale: bigint, fundingIndex: bigint): LiquidationOutcome {
  const { owed, takerPays, fundingPaid, unpaid, takerMargin, makerMargin } = settleFunding(p, fundingIndex, scale);

  const mm = marginRequirement(p.size, mark, mmrWad, scale);
  const pnl = pairPnl(p.isShort, p.size, p.entry, mark, scale);
  const takerBad = below(takerMargin, pnl.takerGains, pnl, takerPays ? mm + unpaid : mm);
  const makerBad = below(makerMargin, !pnl.takerGains, pnl, takerPays ? mm : mm + unpaid);

  const fundingNetted = takerPays === pnl.takerGains ? minOf(pnl.floor, unpaid) : 0n;
  const transfer = pnl.floor - fundingNetted;
  const [loser, gainer] = pnl.takerGains ? [makerMargin, takerMargin] : [takerMargin, makerMargin];
  const paid = minOf(transfer, loser);
  const shortfall = transfer - paid;
  let [takerOut, makerOut] = pnl.takerGains ? [gainer + paid, loser - paid] : [loser - paid, gainer + paid];
  const base = positionFee(p.size, mark, penaltyBps, scale);
  let penalty: bigint;
  if (takerBad) {
    penalty = minOf(base, takerOut);
    takerOut -= penalty;
  } else {
    penalty = minOf(base, makerOut);
    makerOut -= penalty;
  }
  const reward = penalty / 2n;
  return {
    takerBad, makerBad, takerOut, makerOut, penalty, reward, toInsurance: penalty - reward, claim: shortfall,
    takerPaysFunding: takerPays, fundingOwed: owed, fundingPaid, fundingNetted, fundingWrittenOff: unpaid - fundingNetted,
  };
}

export interface LiquidatePublic {
  readonly root: Hex;
  readonly nullifier: Hex;
  readonly commitments: readonly [Hex, Hex, Hex];
  readonly ciphertexts: readonly [readonly Hex[], readonly Hex[], readonly Hex[]];
  readonly market: bigint;
  readonly deltaCommitment: Hex;
  readonly claimCommitment: Hex;
  readonly claimCt: readonly (readonly Hex[])[];
}

export interface ClaimRecord {
  readonly market: bigint;
  readonly asset: bigint;
  readonly amount: bigint;
  readonly ownerAuth: bigint;
  readonly ownerX: bigint;
  readonly ownerY: bigint;
  readonly insIn: bigint;
  readonly pairNonce: bigint;
  readonly deltaCm: bigint;
  readonly recNonce: bigint;
  readonly blind: bigint;
}

const claimPlaintext = (c: ClaimRecord): bigint[] =>
  [c.market, c.asset, c.amount, c.ownerAuth, c.ownerX, c.ownerY, c.insIn, c.pairNonce, c.deltaCm, c.recNonce, c.blind];

export function claimCommitment(deployment: bigint, c: ClaimRecord): bigint {
  return hash([T_CLAIM, deployment, RECORD_VERSION, ...claimPlaintext(c)]);
}

export function openClaim(ct: readonly bigint[], encSk: bigint, deployment: bigint, commitment: bigint): ClaimRecord | null {
  const pt = decryptOrNull(ct, encSk, CLAIM_PT_LEN);
  if (!pt) return null;
  const [market, asset, amount, ownerAuth, ownerX, ownerY, insIn, pairNonce, deltaCm, recNonce, blind] = pt as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  const c: ClaimRecord = { market, asset, amount, ownerAuth, ownerX, ownerY, insIn, pairNonce, deltaCm, recNonce, blind };
  return claimCommitment(deployment, c) === commitment ? c : null;
}

export interface RedeemPublic {
  readonly root: Hex;
  readonly nullifier: Hex;
  readonly commitment: Hex;
  readonly ciphertext: readonly Hex[];
  readonly deltaCommitment: Hex;
  readonly relayFee: FeeOut;
}

/**
 * Pays a folded claim. Needs no key for a zero fee: the note can only go to the claim's committed owner. A nonzero fee
 * needs `sk`, the claim owner's key. The fee defaults to zero to the claim's owner address. `value` is net of the fee.
 */
export function redeemWitness(r: {
  readonly claim: ClaimRecord;
  readonly leafIndex: number;
  readonly deployment: bigint;
  readonly tree: MerkleTree;
  readonly ratio: bigint;
  readonly sk?: bigint;
  readonly relayFee?: RelayFee;
}): { inputs: InputMap; publicInputs: RedeemPublic; value: bigint } {
  const c = r.claim;
  const self: PrivateAddress = { auth: c.ownerAuth, pk: { x: c.ownerX, y: c.ownerY } };
  const fee = r.relayFee ?? zeroRelayFee(self);
  requireOwnerKeyForFee(fee, r.sk, c.ownerAuth);
  const paid = (c.amount * r.ratio) / WAD;
  if (fee.value > paid) throw new RangeError("fee above available");
  const value = paid - fee.value;
  const nf = recNullifier(claimCommitment(r.deployment, c), c.recNonce);
  const out = noteOutput(r.deployment, c.asset, value, outputRho(nf, 0n, 0), self);
  const relay = relayFeeNote(r.deployment, c.asset, nf, 0n, RELAY_RHO_REDEEM, fee);
  const root = r.tree.root();
  const claimInput: InputValue = {
    market: f(c.market), asset: f(c.asset), amount: f(c.amount), owner_auth: f(c.ownerAuth), owner_x: f(c.ownerX), owner_y: f(c.ownerY),
    ins_in: f(c.insIn), pair_nonce: f(c.pairNonce), delta_cm: f(c.deltaCm), rec_nonce: f(c.recNonce), blind: f(c.blind),
  };
  return {
    value,
    inputs: {
      claim: claimInput, index: f(BigInt(r.leafIndex)), path: r.tree.path(r.leafIndex).map(f), blind: f(out.blind), eph: f(out.eph), sk: f(r.sk ?? 0n), relay: relay.input,
      root: f(root), nf: f(nf), cm_out: f(out.commitment), ct: out.ct.map(f), deployment: f(r.deployment), delta_cm: f(c.deltaCm), ratio: f(r.ratio),
      cm_relay: relay.out.commitment, ct_relay: [...relay.out.ct],
    },
    publicInputs: { root: toHex32(root), nullifier: toHex32(nf), commitment: toHex32(out.commitment), ciphertext: out.ct.map(toHex32), deltaCommitment: toHex32(c.deltaCm), relayFee: relay.out },
  };
}

/** Built by a risk worker from a decrypted pair. Takes no owner key. */
export function liquidateWitness(r: {
  readonly pair: PairRecord;
  readonly leafIndex: number;
  readonly deployment: bigint;
  readonly tree: MerkleTree;
  readonly mark: bigint;
  readonly mmrWad: bigint;
  readonly penaltyBps: bigint;
  readonly scale: bigint;
  readonly riskKeys: readonly [Point, Point];
  readonly fundingIndex: bigint;
  /** Where the worker's half of the penalty goes, as a shielded note (D-07). */
  readonly liquidator: PrivateAddress;
}): { inputs: InputMap; publicInputs: LiquidatePublic; outcome: LiquidationOutcome; claim: ClaimRecord } {
  const p = r.pair;
  const outcome = liquidationOutcome(p, r.mark, r.mmrWad, r.penaltyBps, r.scale, r.fundingIndex);
  const cm = pairCommitment(r.deployment, p);
  const nf = recNullifier(cm, p.recNonce);
  const delta = oiDeltaCommitment(r.deployment, p.market, p.isShort, p.size, OI_CLOSE, p.recNonce, outcome.toInsurance, outcome.claim);
  const takerWins = pairPnl(p.isShort, p.size, p.entry, r.mark, r.scale).takerGains;
  const winner = takerWins ? { auth: p.takerAuth, x: p.takerX, y: p.takerY } : { auth: p.makerAuth, x: p.makerX, y: p.makerY };
  const claimSalt = randomField();
  const claim: ClaimRecord = {
    market: p.market, asset: p.asset, amount: outcome.claim, ownerAuth: winner.auth, ownerX: winner.x, ownerY: winner.y, insIn: outcome.toInsurance,
    pairNonce: p.recNonce, deltaCm: delta, recNonce: deriveRecNonce(nf, 0n, 3n, claimSalt), blind: randomField(),
  };
  const cmClaim = claimCommitment(r.deployment, claim);
  const claimKeys: Point[] = [{ x: winner.x, y: winner.y }, r.riskKeys[0], r.riskKeys[1]];
  const claimEphs = claimKeys.map(() => randomField());
  const claimCts = claimKeys.map((k, i) => encrypt(claimPlaintext(claim), k, claimEphs[i]!));
  const outs = [
    { value: outcome.takerOut, auth: p.takerAuth, pk: { x: p.takerX, y: p.takerY } },
    { value: outcome.makerOut, auth: p.makerAuth, pk: { x: p.makerX, y: p.makerY } },
    { value: outcome.reward, auth: r.liquidator.auth, pk: r.liquidator.pk },
  ];
  const built = outs.map((o, i) => {
    const rho = outputRho(nf, 0n, i);
    const [blind, eph] = [randomField(), randomField()];
    const commitment = noteCommitment(r.deployment, p.asset, o.value, noteInner(ownerTag(o), rho, blind));
    return { blind, eph, commitment, ct: encrypt([FREE_DOMAIN, p.asset, o.value, rho, blind], o.pk, eph) };
  });
  const root = r.tree.root();
  return {
    outcome,
    claim,
    inputs: {
      to_insurance: f(outcome.toInsurance), claim_salt: f(claimSalt), claim_blind: f(claim.blind), claim_eph: claimEphs.map(f),
      cm_claim: f(cmClaim), ct_claim: claimCts.map((c) => c.map(f)), risk_pk: r.riskKeys.map((k) => [f(k.x), f(k.y)]),
      pair: pairInput(p), index: f(BigInt(r.leafIndex)), path: r.tree.path(r.leafIndex).map(f),
      liquidator_auth: f(r.liquidator.auth), liquidator_pk: { x: f(r.liquidator.pk.x), y: f(r.liquidator.pk.y) },
      blind: built.map((b) => f(b.blind)), eph: built.map((b) => f(b.eph)),
      root: f(root), nf: f(nf), cm_out: built.map((b) => f(b.commitment)), ct: built.map((b) => b.ct.map(f)),
      deployment: f(r.deployment), market: f(p.market), asset: f(p.asset), mark: f(r.mark), mmr_wad: f(r.mmrWad),
      penalty_bps: f(r.penaltyBps), scale: f(r.scale), funding_index: f(r.fundingIndex), delta_cm: f(delta),
    },
    publicInputs: {
      root: toHex32(root), nullifier: toHex32(nf),
      commitments: [toHex32(built[0]!.commitment), toHex32(built[1]!.commitment), toHex32(built[2]!.commitment)],
      ciphertexts: [built[0]!.ct.map(toHex32), built[1]!.ct.map(toHex32), built[2]!.ct.map(toHex32)],
      market: p.market, deltaCommitment: toHex32(delta), claimCommitment: toHex32(cmClaim), claimCt: claimCts.map((c) => c.map(toHex32)),
    },
  };
}

/** What a close pays, computed independently of the circuit. */
export interface CloseOutcome {
  readonly fill: bigint;
  readonly takerOut: bigint;
  readonly makerOut: bigint;
  readonly fee: bigint;
  /** PnL the losing side could not pay. The winner is short-paid by this; insurance is not used (D-11). */
  readonly shortPaid: bigint;
  readonly takerPaysFunding: boolean;
  readonly fundingOwed: bigint;
  readonly fundingPaid: bigint;
  readonly fundingNetted: bigint;
  readonly fundingWrittenOff: bigint;
}

export function closeOutcome(p: PairRecord, mode: bigint, mark: bigint, scale: bigint, fundingIndex: bigint, feeBps: bigint): CloseOutcome {
  const f0 = settleFunding(p, fundingIndex, scale);
  let fill = p.entry;
  if (mode === CLOSE_MATURED) fill = mark;
  if (mode === CLOSE_TAKER) fill = p.isShort === 0n ? (mark * (BPS - p.closeSpread)) / BPS : ceilDiv(mark * (BPS + p.closeSpread), BPS);
  const pnl = pairPnl(p.isShort, p.size, p.entry, fill, scale);
  const fundingNetted = f0.takerPays === pnl.takerGains ? minOf(pnl.floor, f0.unpaid) : 0n;
  const transfer = pnl.floor - fundingNetted;
  const [loser, gainer] = pnl.takerGains ? [f0.makerMargin, f0.takerMargin] : [f0.takerMargin, f0.makerMargin];
  const paid = minOf(transfer, loser);
  const [takerAfter, makerOut] = pnl.takerGains ? [gainer + paid, loser - paid] : [loser - paid, gainer + paid];
  const fee = mode === CLOSE_TAKER ? minOf(positionFee(p.size, fill, feeBps, scale), takerAfter) : 0n;
  return {
    fill, takerOut: takerAfter - fee, makerOut, fee, shortPaid: transfer - paid, takerPaysFunding: f0.takerPays, fundingOwed: f0.owed, fundingPaid: f0.fundingPaid,
    fundingNetted, fundingWrittenOff: f0.unpaid - fundingNetted,
  };
}

export interface ClosePublic {
  readonly root: Hex;
  readonly nullifier: Hex;
  readonly commitments: readonly [Hex, Hex, Hex];
  readonly ciphertexts: readonly [readonly Hex[], readonly Hex[], readonly Hex[]];
  readonly market: bigint;
  readonly deltaCommitment: Hex;
  readonly mode: bigint;
  readonly relayFee: FeeOut;
}

/**
 * `sk` is the taker's one-time key. Mode 0 needs it; modes 1 and 2 need it only for a nonzero relay fee, which comes out
 * of the taker's payout. The fee defaults to zero to the taker's one-time address.
 */
export function closeWitness(r: {
  readonly pair: PairRecord;
  readonly leafIndex: number;
  readonly deployment: bigint;
  readonly tree: MerkleTree;
  readonly mode: bigint;
  readonly mark: bigint;
  readonly scale: bigint;
  readonly fundingIndex: bigint;
  readonly sk: bigint;
  readonly feeBps: bigint;
  readonly feeTo: PrivateAddress;
  readonly relayFee?: RelayFee;
}): { inputs: InputMap; publicInputs: ClosePublic; outcome: CloseOutcome; takerOut: bigint } {
  const p = r.pair;
  const fee = r.relayFee ?? zeroRelayFee({ auth: p.takerAuth, pk: { x: p.takerX, y: p.takerY } });
  requireOwnerKeyForFee(fee, r.sk, p.takerAuth);
  const outcome = closeOutcome(p, r.mode, r.mark, r.scale, r.fundingIndex, r.feeBps);
  if (fee.value > outcome.takerOut) throw new RangeError("fee above available");
  const takerOut = outcome.takerOut - fee.value;
  const cm = pairCommitment(r.deployment, p);
  const nf = recNullifier(cm, p.recNonce);
  const delta = oiDeltaCommitment(r.deployment, p.market, p.isShort, p.size, OI_CLOSE, p.recNonce);
  const relay = relayFeeNote(r.deployment, p.asset, nf, 0n, RELAY_RHO_CLOSE, fee);
  const outs = [
    { value: takerOut, auth: p.takerAuth, pk: { x: p.takerX, y: p.takerY } },
    { value: outcome.makerOut, auth: p.makerAuth, pk: { x: p.makerX, y: p.makerY } },
    { value: outcome.fee, auth: r.feeTo.auth, pk: r.feeTo.pk },
  ];
  const built = outs.map((o, i) => {
    const rho = outputRho(nf, 0n, i);
    const [blind, eph] = [randomField(), randomField()];
    const commitment = noteCommitment(r.deployment, p.asset, o.value, noteInner(ownerTag(o), rho, blind));
    return { blind, eph, commitment, ct: encrypt([FREE_DOMAIN, p.asset, o.value, rho, blind], o.pk, eph) };
  });
  const root = r.tree.root();
  return {
    outcome,
    takerOut,
    inputs: {
      fee_bps: f(r.feeBps), fee_auth: f(r.feeTo.auth), fee_pk: [f(r.feeTo.pk.x), f(r.feeTo.pk.y)], relay: relay.input, cm_relay: relay.out.commitment, ct_relay: [...relay.out.ct],
      pair: pairInput(p), index: f(BigInt(r.leafIndex)), path: r.tree.path(r.leafIndex).map(f), sk: f(r.sk),
      blind: built.map((b) => f(b.blind)), eph: built.map((b) => f(b.eph)),
      root: f(root), nf: f(nf), cm_out: built.map((b) => f(b.commitment)), ct: built.map((b) => b.ct.map(f)),
      deployment: f(r.deployment), market: f(p.market), asset: f(p.asset), mark: f(r.mark), scale: f(r.scale),
      funding_index: f(r.fundingIndex), delta_cm: f(delta), mode: f(r.mode),
    },
    publicInputs: {
      root: toHex32(root), nullifier: toHex32(nf),
      commitments: [toHex32(built[0]!.commitment), toHex32(built[1]!.commitment), toHex32(built[2]!.commitment)],
      ciphertexts: [built[0]!.ct.map(toHex32), built[1]!.ct.map(toHex32), built[2]!.ct.map(toHex32)],
      market: p.market, deltaCommitment: toHex32(delta), mode: r.mode, relayFee: relay.out,
    },
  };
}

/** Next version of a pair, computed independently of the circuit. `refused` names the constraint that must fail. */
export interface UpdateOutcome {
  readonly refused: string | null;
  readonly takerMargin: bigint;
  readonly makerMargin: bigint;
  readonly size: bigint;
  readonly fee: bigint;
  readonly fundingDebt: bigint;
  readonly debtByTaker: bigint;
  readonly fundingOwed: bigint;
  readonly fundingPaid: bigint;
  readonly fundingNetted: bigint;
}

export interface UpdateRequest {
  readonly actor: bigint;
  readonly add: bigint;
  readonly remove: bigint;
  readonly reduce: bigint;
}

/** Contract-supplied rules an update is checked against besides the market's prices. */
export interface UpdateGuard {
  /** Maintenance fraction: with a fresh mark, the next version must not be liquidatable. */
  readonly mmrWad: bigint;
  /** The version's timestamp, near the latest block time (the contract bounds it). */
  readonly asOf: bigint;
  /** Cooldown between versions of one lineage. */
  readonly minGap?: bigint;
}

/** When a pair can next be changed by anything but a cure. Until TAKER_GRACE seconds after that, only the taker can. */
export const nextUpdateAt = (p: PairRecord, minGap: bigint = MIN_UPDATE_GAP): bigint => p.updatedAt + minGap;

/** pair_update's `updated_at` rule: a cure inside the cooldown keeps the replaced version's clock. */
const clockAfter = (p: PairRecord, asOf: bigint, minGap: bigint = MIN_UPDATE_GAP): bigint => (asOf < nextUpdateAt(p, minGap) ? p.updatedAt : asOf);

/** lib.nr `side_below_im`: gains count only up to what the counterparty has posted, and unpaid funding counts against its payer. */
function sideBelowIm(takerSide: boolean, takerMargin: bigint, makerMargin: bigint, takerPays: boolean, unpaid: bigint, h: PairPnl, im: bigint): boolean {
  const certified = { ...h, floor: minOf(h.floor, takerSide ? makerMargin : takerMargin) };
  const required = takerSide === takerPays ? im + unpaid : im;
  return below(takerSide ? takerMargin : makerMargin, takerSide ? h.takerGains : !h.takerGains, certified, required);
}

export function updateOutcome(p: PairRecord, u: UpdateRequest, mark: bigint, imrWad: bigint, scale: bigint, fundingIndex: bigint, feeBps: bigint, guard: UpdateGuard): UpdateOutcome {
  const f0 = settleFunding(p, fundingIndex, scale);
  const fill = p.isShort === 0n ? (mark * (BPS - p.closeSpread)) / BPS : ceilDiv(mark * (BPS + p.closeSpread), BPS);
  const realized = pairPnl(p.isShort, u.reduce, p.entry, fill, scale);
  const netted = f0.takerPays === realized.takerGains ? minOf(realized.floor, f0.unpaid) : 0n;
  const unpaid = f0.unpaid - netted;
  const transfer = realized.floor - netted;
  const [loser, gainer] = realized.takerGains ? [f0.makerMargin, f0.takerMargin] : [f0.takerMargin, f0.makerMargin];
  const base = { size: p.size - u.reduce, fundingOwed: f0.owed, fundingPaid: f0.fundingPaid, fundingNetted: netted, fundingDebt: unpaid, debtByTaker: unpaid !== 0n && f0.takerPays ? 1n : 0n };
  if (loser < transfer) return { ...base, refused: "underwater pair cannot reduce", takerMargin: 0n, makerMargin: 0n, fee: 0n };
  const [takerAfter, makerAfter] = realized.takerGains ? [gainer + transfer, loser - transfer] : [loser - transfer, gainer + transfer];
  const fee = minOf(positionFee(u.reduce, fill, feeBps, scale), takerAfter);
  let takerMargin = takerAfter - fee + (u.actor === ACTOR_TAKER ? u.add : 0n);
  let makerMargin = makerAfter + (u.actor === ACTOR_MAKER ? u.add : 0n);
  const own = u.actor === ACTOR_TAKER ? takerMargin : makerMargin;
  if (u.actor !== ACTOR_NONE && own < u.remove) return { ...base, refused: "removal above margin", takerMargin: 0n, makerMargin: 0n, fee };
  if (u.actor === ACTOR_TAKER) takerMargin -= u.remove;
  if (u.actor === ACTOR_MAKER) makerMargin -= u.remove;
  const refuse = (refused: string): UpdateOutcome => ({ ...base, refused, takerMargin: 0n, makerMargin: 0n, fee });
  const isTaker = u.actor === ACTOR_TAKER;
  const im = marginRequirement(base.size, mark, imrWad, scale);
  const atMark = pairPnl(p.isShort, base.size, p.entry, mark, scale);
  if (u.remove !== 0n && sideBelowIm(isTaker, takerMargin, makerMargin, f0.takerPays, unpaid, atMark, im)) return refuse("below initial margin");
  // Inside the cooldown only a cure runs, and it must reach initial margin. After it, a partial top-up is an ordinary add.
  const cooldownEnd = nextUpdateAt(p, guard.minGap);
  if (guard.asOf < cooldownEnd) {
    const preBad = sideBelowIm(isTaker, f0.takerMargin, f0.makerMargin, f0.takerPays, f0.unpaid, atMark, im);
    const cure = u.actor !== ACTOR_NONE && u.add !== 0n && u.remove === 0n && u.reduce === 0n && mark !== 0n && preBad;
    if (!cure) return refuse("update cooldown");
    if (sideBelowIm(isTaker, takerMargin, makerMargin, f0.takerPays, unpaid, atMark, im)) return refuse("cure must reach initial margin");
  } else if (guard.asOf < cooldownEnd + TAKER_GRACE && !isTaker) {
    return refuse("taker grace");
  }
  if (mark !== 0n) {
    const next: PairRecord = { ...p, size: base.size, fundingIndex, fundingDebt: base.fundingDebt, debtByTaker: base.debtByTaker, takerMargin, makerMargin };
    const health = liquidationOutcome(next, mark, guard.mmrWad, 0n, scale, fundingIndex);
    if (health.takerBad || health.makerBad) return refuse("update leaves pair liquidatable");
  }
  return { ...base, refused: null, takerMargin, makerMargin, fee };
}

export interface UpdatePublic {
  readonly root: Hex;
  readonly nullifiers: readonly [Hex, Hex];
  readonly pairCommitment: Hex;
  readonly outCommitment: Hex;
  readonly feeCommitment: Hex;
  readonly pairCt: readonly (readonly Hex[])[];
  readonly outCt: readonly Hex[];
  readonly feeCt: readonly Hex[];
  readonly market: bigint;
  readonly deltaCommitment: Hex;
  readonly carriedNullifier: Hex;
  readonly asOf: bigint;
  readonly relayFee: FeeOut;
}

/**
 * `sk` is the acting owner's one-time key. `noteOwner` spends `note` when margin is added; both are optional. The relay
 * fee comes out of the actor's out note and defaults to zero to `noteOwner`. Actor 0 has no key and can only pay zero.
 */
export function updateWitness(r: {
  readonly pair: PairRecord;
  readonly leafIndex: number;
  readonly deployment: bigint;
  readonly tree: MerkleTree;
  readonly update: UpdateRequest;
  readonly sk: bigint;
  readonly noteOwner: WalletKeys;
  readonly note?: OwnedNote;
  readonly mark: bigint;
  readonly imrWad: bigint;
  readonly mmrWad: bigint;
  readonly scale: bigint;
  readonly feeBps: bigint;
  readonly fundingIndex: bigint;
  readonly riskKeys: readonly [Point, Point];
  readonly feeTo: PrivateAddress;
  readonly asOf: bigint;
  readonly minGap?: bigint;
  /** Set when the pair has a pending exit request, so the request moves to the next version. */
  readonly carryExit?: boolean;
  readonly relayFee?: RelayFee;
}): { inputs: InputMap; publicInputs: UpdatePublic; record: PairRecord; outcome: UpdateOutcome; outValue: bigint } {
  const p = r.pair;
  const u = r.update;
  const minGap = r.minGap ?? MIN_UPDATE_GAP;
  const fee = r.relayFee ?? zeroRelayFee(addressOf(r.noteOwner));
  if (fee.value !== 0n && u.actor === ACTOR_NONE) throw new Error("fee needs the owner key");
  const outcome = updateOutcome(p, u, r.mark, r.imrWad, r.scale, r.fundingIndex, r.feeBps, { mmrWad: r.mmrWad, asOf: r.asOf, minGap });
  const [note] = padInputs(r.noteOwner, r.deployment, p.asset, [r.note ?? zeroNote(r.noteOwner, r.deployment, p.asset)]);
  if (note.value - u.add + u.remove < fee.value) throw new RangeError("fee above available");
  const nf0 = recNullifier(pairCommitment(r.deployment, p), p.recNonce);
  const nf1 = note.nullifier;
  const salt = randomField();
  const record: PairRecord = {
    ...p, size: outcome.size, fundingIndex: r.fundingIndex, fundingDebt: outcome.fundingDebt, debtByTaker: outcome.debtByTaker, lastReduce: u.reduce, updatedAt: clockAfter(p, r.asOf, minGap),
    takerMargin: outcome.takerMargin, makerMargin: outcome.makerMargin, recNonce: deriveRecNonce(nf0, nf1, 0n, salt), blind: randomField(),
  };
  const cm = pairCommitment(r.deployment, record);
  const carried = r.carryExit ? recNullifier(cm, record.recNonce) : 0n;
  const delta = oiDeltaCommitment(r.deployment, p.market, p.isShort, u.reduce, OI_REDUCE, record.recNonce);
  const keys: Point[] = [{ x: p.takerX, y: p.takerY }, { x: p.makerX, y: p.makerY }, r.riskKeys[0], r.riskKeys[1]];
  const ephs = keys.map(() => randomField());
  const pt = pairPlaintext(record);
  const cts = keys.map((k, i) => encrypt(pt, k, ephs[i]!));
  const outValue = note.value - u.add + u.remove - fee.value;
  const to: PrivateAddress = u.actor === ACTOR_MAKER ? { auth: p.makerAuth, pk: keys[1]! } : { auth: p.takerAuth, pk: keys[0]! };
  const out = noteOutput(r.deployment, p.asset, outValue, outputRho(nf0, nf1, 1), to);
  const feeNote = noteOutput(r.deployment, p.asset, outcome.fee, outputRho(nf0, nf1, 2), r.feeTo);
  const relay = relayFeeNote(r.deployment, p.asset, nf0, nf1, RELAY_RHO_UPDATE, fee);
  const root = r.tree.root();
  const zeroPath = Array.from({ length: r.tree.depth }, () => f(0n));
  return {
    record, outcome, outValue,
    inputs: {
      pair: pairInput(p), index: f(BigInt(r.leafIndex)), path: r.tree.path(r.leafIndex).map(f), actor: f(u.actor), sk: f(r.sk),
      spender_sk: f(r.noteOwner.sk), spender_pk: { x: f(r.noteOwner.pk.x), y: f(r.noteOwner.pk.y) },
      note: { value: f(note.value), rho: f(note.rho), blind: f(note.blind), index: f(BigInt(note.leafIndex)), path: note.value === 0n ? zeroPath : r.tree.path(note.leafIndex).map(f) },
      add: f(u.add), remove: f(u.remove), reduce: f(u.reduce), salt: f(salt), new_blind: f(record.blind), pair_eph: ephs.map(f),
      out_blind: f(out.blind), out_eph: f(out.eph), fee_blind: f(feeNote.blind), fee_eph: f(feeNote.eph), relay: relay.input,
      root: f(root), nf: [f(nf0), f(nf1)], cm_pair: f(cm), cm_out: f(out.commitment), cm_fee: f(feeNote.commitment), ct_pair: cts.map((c) => c.map(f)),
      ct_out: out.ct.map(f), ct_fee: feeNote.ct.map(f), deployment: f(r.deployment), market: f(p.market), asset: f(p.asset), mark: f(r.mark), imr_wad: f(r.imrWad), scale: f(r.scale),
      fee_bps: f(r.feeBps), funding_index: f(r.fundingIndex), delta_cm: f(delta), risk_pk: r.riskKeys.map((k) => [f(k.x), f(k.y)]),
      fee_auth: f(r.feeTo.auth), fee_pk: [f(r.feeTo.pk.x), f(r.feeTo.pk.y)], carried_nf: f(carried),
      mmr_wad: f(r.mmrWad), as_of: f(r.asOf), min_gap: f(minGap), cm_relay: relay.out.commitment, ct_relay: [...relay.out.ct],
    },
    publicInputs: {
      carriedNullifier: toHex32(carried),
      root: toHex32(root), nullifiers: [toHex32(nf0), toHex32(nf1)], pairCommitment: toHex32(cm), outCommitment: toHex32(out.commitment), feeCommitment: toHex32(feeNote.commitment),
      pairCt: cts.map((c) => c.map(toHex32)), outCt: out.ct.map(toHex32), feeCt: feeNote.ct.map(toHex32), market: p.market, deltaCommitment: toHex32(delta),
      asOf: r.asOf, relayFee: relay.out,
    },
  };
}

function zeroNote(keys: WalletKeys, deployment: bigint, asset: bigint): OwnedNote {
  const rho = randomField();
  const blind = randomField();
  const commitment = noteCommitment(deployment, asset, 0n, noteInner(keys.owner, rho, blind));
  return { leafIndex: 0, asset, value: 0n, rho, blind, commitment, nullifier: ownerNullifier(keys.nk, commitment) };
}

export function exitRequestWitness(r: {
  readonly pair: PairRecord;
  readonly leafIndex: number;
  readonly deployment: bigint;
  readonly tree: MerkleTree;
  readonly sk: bigint;
}): { inputs: InputMap; root: Hex; nullifier: Hex } {
  const nf = recNullifier(pairCommitment(r.deployment, r.pair), r.pair.recNonce);
  const root = r.tree.root();
  return {
    root: toHex32(root),
    nullifier: toHex32(nf),
    inputs: { pair: pairInput(r.pair), index: f(BigInt(r.leafIndex)), path: r.tree.path(r.leafIndex).map(f), sk: f(r.sk), root: f(root), nf: f(nf), deployment: f(r.deployment) },
  };
}

// Funding epochs (D-08). Truncating integer steps, as RiskMath.fundingRatePerSecond and fundingIndexDelta.

export interface OiDelta {
  readonly isShort: bigint;
  readonly size: bigint;
  /** OI_OPEN adds to open interest; OI_CLOSE and OI_REDUCE remove from it. */
  readonly kind: bigint;
  readonly recNonce: bigint;
  /** Penalty share entering insurance. Omitted means 0. */
  readonly insIn?: bigint;
  /** Shortfall asking to be covered. Omitted means 0. */
  readonly claim?: bigint;
}

export interface MarketState {
  readonly longOi: bigint;
  readonly shortOi: bigint;
  readonly insurance: bigint;
  readonly badDebt: bigint;
  /** How much of the market's creator bond has gone to cover shortfalls. */
  readonly bondUsed: bigint;
  readonly blind: bigint;
}

/** One epoch's batch: penalty shares arrive first, then every claim is paid the same ratio, from insurance before the bond. */
export function foldClaims(insurance: bigint, inflow: bigint, claims: readonly bigint[], bondLeft = 0n): { ratio: bigint; payouts: bigint[]; insuranceNext: bigint; badDebtAdded: bigint; bondUsedAdded: bigint } {
  const insuranceIn = insurance + inflow;
  const available = insuranceIn + bondLeft;
  const total = claims.reduce((a, c) => a + c, 0n);
  const ratio = total === 0n ? WAD : (minOf(available, total) * WAD) / total;
  const payouts = claims.map((c) => (c * ratio) / WAD);
  const paid = payouts.reduce((a, c) => a + c, 0n);
  const fromInsurance = minOf(paid, insuranceIn);
  return { ratio, payouts, insuranceNext: insuranceIn - fromInsurance, badDebtAdded: total - paid, bondUsedAdded: paid - fromInsurance };
}

export function epochIndexChange(longOi: bigint, shortOi: bigint, maxRatePerHourWad: bigint, dt: bigint, mark: bigint): { mag: bigint; neg: bigint } {
  const total = longOi + shortOi;
  if (total === 0n) return { mag: 0n, neg: 0n };
  const up = longOi >= shortOi;
  const skew = ((up ? longOi - shortOi : shortOi - longOi) * WAD) / total;
  const rate = ((maxRatePerHourWad / 3600n) * skew) / WAD;
  return { mag: (rate * dt * mark) / WAD, neg: up ? 0n : 1n };
}

export interface FundingPublic {
  readonly market: bigint;
  readonly newHead: Hex;
  readonly asOf: bigint;
  readonly indexMag: bigint;
  readonly indexNeg: bigint;
  readonly claimRatio: bigint;
  readonly ciphertexts: readonly (readonly Hex[])[];
  /** Public bond draw before and after the batch; the contract checks the first and stores the second. */
  readonly bondUsedPrev: bigint;
  readonly bondUsedNext: bigint;
}

export function marketHead(deployment: bigint, market: bigint, s: MarketState): bigint {
  return hash([T_MARKET, deployment, RECORD_VERSION, market, s.longOi, s.shortOi, s.insurance, s.badDebt, s.bondUsed, s.blind]);
}

/** Proves a closed market is empty and how much of its bond was used. Reveals only that amount. */
export function bondReleaseWitness(r: { readonly deployment: bigint; readonly market: bigint; readonly state: MarketState; readonly head: bigint }): { inputs: InputMap; bondUsed: bigint } {
  return {
    bondUsed: r.state.bondUsed,
    inputs: {
      insurance: f(r.state.insurance), bad_debt: f(r.state.badDebt), blind: f(r.state.blind),
      deployment: f(r.deployment), market: f(r.market), head: f(r.head), bond_used: f(r.state.bondUsed),
    },
  };
}

export interface SweepPublic {
  readonly market: bigint;
  readonly newHead: Hex;
  readonly commitment: Hex;
  readonly ciphertext: readonly Hex[];
  readonly marketCt: readonly (readonly Hex[])[];
}

/** Moves a wound-down market's insurance to the fee address (D-17). */
export function insuranceSweepWitness(r: {
  readonly deployment: bigint;
  readonly market: bigint;
  readonly asset: bigint;
  readonly state: MarketState;
  readonly head: bigint;
  readonly feeTo: PrivateAddress;
  readonly keys: readonly [Point, Point, Point];
}): { inputs: InputMap; publicInputs: SweepPublic; next: MarketState } {
  const next: MarketState = { longOi: 0n, shortOi: 0n, insurance: 0n, badDebt: r.state.badDebt, bondUsed: r.state.bondUsed, blind: randomField() };
  const newHead = marketHead(r.deployment, r.market, next);
  const out = noteOutput(r.deployment, r.asset, r.state.insurance, outputRho(r.head, newHead, 0), r.feeTo);
  const ephs = r.keys.map(() => randomField());
  const cts = r.keys.map((k, i) => encrypt([0n, 0n, 0n, next.badDebt, next.bondUsed, next.blind], k, ephs[i]!));
  return {
    next,
    inputs: {
      insurance: f(r.state.insurance), bad_debt: f(r.state.badDebt), bond_used: f(r.state.bondUsed), blind: f(r.state.blind), new_blind: f(next.blind), out_blind: f(out.blind), out_eph: f(out.eph), eph: ephs.map(f),
      deployment: f(r.deployment), market: f(r.market), asset: f(r.asset), head: f(r.head), new_head: f(newHead), cm_out: f(out.commitment), ct_out: out.ct.map(f),
      fee_auth: f(r.feeTo.auth), fee_pk: [f(r.feeTo.pk.x), f(r.feeTo.pk.y)], keys: r.keys.map((k) => [f(k.x), f(k.y)]), ct: cts.map((c) => c.map(f)),
    },
    publicInputs: { market: r.market, newHead: toHex32(newHead), commitment: toHex32(out.commitment), ciphertext: out.ct.map(toHex32), marketCt: cts.map((c) => c.map(toHex32)) },
  };
}

export function fundingEpochWitness(r: {
  readonly deployment: bigint;
  readonly market: bigint;
  readonly state: MarketState;
  /** On-chain head; zero until the first epoch. */
  readonly head: bigint;
  /** Oldest pending changes, in queue order, with their on-chain commitments. */
  readonly deltas: readonly { readonly opening: OiDelta; readonly commitment: bigint }[];
  readonly asOf: bigint;
  readonly dt: bigint;
  readonly mark: bigint;
  readonly maxRateWad: bigint;
  readonly keys: readonly [Point, Point, Point];
  /** The market's creator bond, as on chain. Zero for markets fixed at deployment. */
  readonly bondTotal?: bigint;
}): { inputs: InputMap; publicInputs: FundingPublic; next: MarketState } {
  if (r.deltas.length > OI_BATCH) throw new RangeError("too many open-interest changes");
  const { mag, neg } = epochIndexChange(r.state.longOi, r.state.shortOi, r.maxRateWad, r.dt, r.mark);
  let [longOi, shortOi] = [r.state.longOi, r.state.shortOi];
  for (const { opening: d } of r.deltas) {
    if (d.kind !== OI_OPEN && d.kind !== OI_CLOSE && d.kind !== OI_REDUCE) throw new RangeError("unknown kind");
    const signed = d.kind === OI_OPEN ? d.size : -d.size;
    if (d.isShort === 0n) longOi += signed;
    else shortOi += signed;
  }
  const folded = foldClaims(r.state.insurance, r.deltas.reduce((a, d) => a + (d.opening.insIn ?? 0n), 0n), r.deltas.map((d) => d.opening.claim ?? 0n), (r.bondTotal ?? 0n) - r.state.bondUsed);
  const next: MarketState = { longOi, shortOi, insurance: folded.insuranceNext, badDebt: r.state.badDebt + folded.badDebtAdded, bondUsed: r.state.bondUsed + folded.bondUsedAdded, blind: randomField() };
  const newHead = marketHead(r.deployment, r.market, next);
  const ephs = r.keys.map(() => randomField());
  const cts = r.keys.map((k, i) => encrypt([longOi, shortOi, next.insurance, next.badDebt, next.bondUsed, next.blind], k, ephs[i]!));
  const blank: OiDelta = { isShort: 0n, size: 0n, kind: OI_OPEN, recNonce: 0n };
  const slots = Array.from({ length: OI_BATCH }, (_, i) => r.deltas[i]);
  return {
    next,
    inputs: {
      long_oi: f(r.state.longOi), short_oi: f(r.state.shortOi), insurance: f(r.state.insurance), bad_debt: f(r.state.badDebt), bond_used: f(r.state.bondUsed), blind: f(r.state.blind), new_blind: f(next.blind),
      deltas: slots.map((s) => {
        const d = s?.opening ?? blank;
        return { is_short: f(d.isShort), size: f(d.size), kind: f(d.kind), ins_in: f(d.insIn ?? 0n), claim: f(d.claim ?? 0n), rec_nonce: f(d.recNonce) };
      }),
      eph: ephs.map(f),
      deployment: f(r.deployment), market: f(r.market), head: f(r.head), new_head: f(newHead), count: f(BigInt(r.deltas.length)),
      delta_cm: slots.map((s) => f(s?.commitment ?? 0n)), dt: f(r.dt), mark: f(r.mark), max_rate_wad: f(r.maxRateWad),
      index_mag: f(mag), index_neg: f(neg), claim_ratio: f(folded.ratio), bond_total: f(r.bondTotal ?? 0n), keys: r.keys.map((k) => [f(k.x), f(k.y)]), ct: cts.map((c) => c.map(f)),
      bond_used_prev: f(r.state.bondUsed), bond_used_next: f(next.bondUsed),
    },
    publicInputs: {
      market: r.market, newHead: toHex32(newHead), asOf: r.asOf, indexMag: mag, indexNeg: neg, claimRatio: folded.ratio, ciphertexts: cts.map((c) => c.map(toHex32)),
      bondUsedPrev: r.state.bondUsed, bondUsedNext: next.bondUsed,
    },
  };
}
