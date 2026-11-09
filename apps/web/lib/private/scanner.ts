import {
  CLAIM_CT_LEN, CLAIM_CT_WINNER, CLOSE_MATURED, closeOutcome, deriveKeys, depositOpening, liquidationOutcome, LOCK_CT_LEN, lockAddressKeys, lockCommitment, LP_CT_LEN, lpCommitment, noteCommitment, noteInner, openClaim, openLock, openLp,
  openPair, outputRho, ownerNullifier, PAIR_CT_LEN, PAIR_CT_MAKER, PAIR_CT_TAKER, pairCommitment, recNullifier, RECORD_CLAIM, RECORD_FREE, RECORD_LOCK, RECORD_LP, RECORD_PAIR, ROLE_LP, ROLE_MAKER, ROLE_SWAP, ROLE_TAKER, scanCreated, toHex32, updateOutcome,
  ACTOR_NONE, claimCommitment, type ClaimRecord, type LockRecord, type LpRecord, type OwnedNote, type PairRecord, type WalletKeys,
} from "@rooq/private-sdk";
import { getAddress, type Hex } from "viem";
import { formatFixed } from "@rooq/sdk";
import type { ChainState, RecordRow } from "./chain-state";
import type { ActivityEntry, BalanceView, ClaimView, FundingEntry, LockRole, LockView, LpView, PositionView, PrivateView } from "./types";

const ADDRESS_GAP = 30;
const DEPOSIT_GAP = 20;

export type HeldNote = OwnedNote & { readonly keys: WalletKeys; readonly keyIndex: number; readonly block: bigint };

export interface HeldLock {
  readonly record: LockRecord;
  readonly leafIndex: number;
  readonly commitment: bigint;
  readonly nullifier: bigint;
  readonly keyIndex: number;
  readonly keys: WalletKeys;
  readonly block: bigint;
}

export interface PairVersion {
  readonly pair: PairRecord;
  readonly leafIndex: number;
  readonly commitment: bigint;
  readonly nullifier: bigint;
  readonly block: bigint;
}

export interface HeldPosition {
  readonly id: string;
  readonly keyIndex: number;
  readonly keys: WalletKeys;
  readonly side: "taker" | "maker";
  readonly versions: readonly PairVersion[];
}

export interface HeldClaim {
  readonly record: ClaimRecord;
  readonly leafIndex: number;
  readonly commitment: bigint;
  readonly nullifier: bigint;
  readonly keys: WalletKeys;
  readonly block: bigint;
}

export interface HeldLp {
  readonly record: LpRecord;
  readonly leafIndex: number;
  readonly commitment: bigint;
  readonly nullifier: bigint;
  readonly keys: WalletKeys;
  readonly block: bigint;
}

const roleOf = (role: bigint): LockRole => (role === ROLE_TAKER ? "taker" : role === ROLE_MAKER ? "maker" : role === ROLE_SWAP ? "swap" : "lp");
const hex20 = (x: bigint): Hex => `0x${x.toString(16).padStart(40, "0")}`;

export interface Decoded {
  readonly notes: readonly HeldNote[];
  readonly allNotesByRho: ReadonlyMap<bigint, HeldNote>;
  readonly locks: readonly HeldLock[];
  readonly positions: readonly HeldPosition[];
  readonly claims: readonly HeldClaim[];
  readonly lps: readonly HeldLp[];
  readonly nextAddress: number;
  readonly nextDeposit: number;
}

/**
 * Finds this wallet's records in public chain data (REC-02). Results are cached by commitment and address, so a rescan
 * only costs work for new records or newly used one-time addresses. A ciphertext counts only if it rebuilds its commitment.
 */
export class Scanner {
  readonly main: WalletKeys;
  private readonly addresses = new Map<number, WalletKeys>();
  private readonly noteCache = new Map<string, OwnedNote | null>();
  private readonly lockCache = new Map<bigint, LockRecord | null>();
  private readonly pairCache = new Map<string, PairRecord | null>();
  private readonly claimCache = new Map<string, ClaimRecord | null>();
  private readonly lpCache = new Map<string, LpRecord | null>();

  constructor(readonly seed: bigint) {
    this.main = deriveKeys(seed);
  }

  address(index: number): WalletKeys {
    let k = this.addresses.get(index);
    if (!k) {
      k = lockAddressKeys(this.seed, index);
      this.addresses.set(index, k);
    }
    return k;
  }

  decode(chain: ChainState): Decoded {
    const dep = chain.deployment!;
    const spent = chain.spent;
    const isSpent = (nf: bigint) => spent.has(toHex32(nf));
    const lockRows = chain.records.filter((r) => r.kind === RECORD_LOCK);
    const ownLocks: { row: RecordRow; record: LockRecord }[] = [];
    for (const r of lockRows) {
      let record = this.lockCache.get(r.commitment);
      if (record === undefined) {
        record = openLock(r.ciphertext.slice(0, LOCK_CT_LEN), this.main.encSk, dep.id, r.commitment);
        this.lockCache.set(r.commitment, record);
      }
      if (record) ownLocks.push({ row: r, record });
    }
    const payouts = new Map<bigint, LockRecord>(ownLocks.map((l) => [l.record.ownerX, l.record]));
    const usedAddresses: { index: number; keys: WalletKeys }[] = [];
    let nextAddress = 0;
    for (let i = 0, misses = 0; misses < ADDRESS_GAP; i++) {
      const k = this.address(i);
      if (payouts.has(k.pk.x)) {
        usedAddresses.push({ index: i, keys: k });
        nextAddress = i + 1;
        misses = 0;
      } else {
        misses++;
      }
    }
    const byOwner = new Map(usedAddresses.map((a) => [a.keys.pk.x, a]));

    const locks: HeldLock[] = ownLocks.flatMap(({ row, record }) => {
      const a = byOwner.get(record.ownerX);
      return a ? [{ record, leafIndex: row.leafIndex, commitment: row.commitment, nullifier: recNullifier(row.commitment, record.recNonce), keyIndex: a.index, keys: a.keys, block: row.block }] : [];
    });

    const allNotes: HeldNote[] = [];
    let nextDeposit = 0;
    const byInner = new Map<bigint, (typeof chain.deposits)[number][]>();
    for (const d of chain.deposits) byInner.set(d.inner, [...(byInner.get(d.inner) ?? []), d]);
    for (let k = 0, misses = 0; misses < DEPOSIT_GAP; k++) {
      const { rho, blind } = depositOpening(this.seed, k);
      const found = byInner.get(noteInner(this.main.owner, rho, blind));
      if (!found) {
        misses++;
        continue;
      }
      misses = 0;
      nextDeposit = k + 1;
      for (const d of found) {
        const cm = noteCommitment(dep.id, d.asset, d.amount, d.inner);
        allNotes.push({ leafIndex: d.leafIndex, asset: d.asset, value: d.amount, rho, blind, commitment: cm, nullifier: ownerNullifier(this.main.nk, cm), keys: this.main, keyIndex: -1, block: d.block });
      }
    }
    const free = chain.records.filter((r) => r.kind === RECORD_FREE);
    const keysList = [{ index: -1, keys: this.main }, ...usedAddresses];
    for (const { index, keys } of keysList) {
      for (const r of free) {
        const key = `${keys.pk.x}:${r.commitment}`;
        let n = this.noteCache.get(key);
        if (n === undefined) {
          n = scanCreated(keys, dep.id, [{ firstLeafIndex: r.leafIndex, commitments: [r.commitment], ciphertexts: [r.ciphertext] }])[0] ?? null;
          this.noteCache.set(key, n);
        }
        if (n) allNotes.push({ ...n, keys, keyIndex: index, block: r.block });
      }
    }
    const notes = allNotes.filter((n) => n.value > 0n && !isSpent(n.nullifier)).sort((a, b) => a.leafIndex - b.leafIndex);
    const allNotesByRho = new Map(allNotes.map((n) => [n.rho, n]));

    const pairRows = chain.records.filter((r) => r.kind === RECORD_PAIR);
    const claimRows = chain.records.filter((r) => r.kind === RECORD_CLAIM);
    const lpRows = chain.records.filter((r) => r.kind === RECORD_LP);
    const positions: HeldPosition[] = [];
    const claims: HeldClaim[] = [];
    const lps: HeldLp[] = [];
    for (const a of usedAddresses) {
      const payoutLock = payouts.get(a.keys.pk.x);
      if (!payoutLock) continue;
      const side = payoutLock.role === ROLE_MAKER ? "maker" : "taker";
      if (payoutLock.role === ROLE_TAKER || payoutLock.role === ROLE_MAKER) {
        const slot = side === "taker" ? PAIR_CT_TAKER : PAIR_CT_MAKER;
        const versions: PairVersion[] = [];
        for (const r of pairRows) {
          const key = `${a.keys.pk.x}:${r.commitment}`;
          let p = this.pairCache.get(key);
          if (p === undefined) {
            p = openPair(r.ciphertext.slice(slot * PAIR_CT_LEN, (slot + 1) * PAIR_CT_LEN), a.keys.encSk, dep.id, r.commitment);
            this.pairCache.set(key, p);
          }
          if (p) versions.push({ pair: p, leafIndex: r.leafIndex, commitment: r.commitment, nullifier: recNullifier(pairCommitment(dep.id, p), p.recNonce), block: r.block });
        }
        if (versions.length > 0) positions.push({ id: `p:${a.index}`, keyIndex: a.index, keys: a.keys, side, versions });
        for (const r of claimRows) {
          const key = `${a.keys.pk.x}:${r.commitment}`;
          let c = this.claimCache.get(key);
          if (c === undefined) {
            c = openClaim(r.ciphertext.slice(CLAIM_CT_WINNER * CLAIM_CT_LEN, (CLAIM_CT_WINNER + 1) * CLAIM_CT_LEN), a.keys.encSk, dep.id, r.commitment);
            this.claimCache.set(key, c);
          }
          if (c) claims.push({ record: c, leafIndex: r.leafIndex, commitment: r.commitment, nullifier: recNullifier(claimCommitment(dep.id, c), c.recNonce), keys: a.keys, block: r.block });
        }
      }
      if (payoutLock.role === ROLE_LP) {
        for (const r of lpRows) {
          const key = `${a.keys.pk.x}:${r.commitment}`;
          let l = this.lpCache.get(key);
          if (l === undefined) {
            l = openLp(r.ciphertext.slice(0, LP_CT_LEN), a.keys.encSk, dep.id, r.commitment);
            this.lpCache.set(key, l);
          }
          if (l) lps.push({ record: l, leafIndex: r.leafIndex, commitment: r.commitment, nullifier: recNullifier(lpCommitment(dep.id, l), l.recNonce), keys: a.keys, block: r.block });
        }
      }
    }
    return { notes, allNotesByRho, locks, positions, claims, lps, nextAddress, nextDeposit };
  }
}

export function largestPair(notes: readonly HeldNote[]): readonly HeldNote[] {
  const byKey = new Map<number, HeldNote[]>();
  for (const n of notes) byKey.set(n.keyIndex, [...(byKey.get(n.keyIndex) ?? []), n]);
  let best: readonly HeldNote[] = [];
  let bestSum = 0n;
  for (const group of byKey.values()) {
    const top = [...group].sort((a, b) => (a.value < b.value ? 1 : -1)).slice(0, 2);
    const sum = top.reduce((s, n) => s + n.value, 0n);
    if (sum > bestSum) [best, bestSum] = [top, sum];
  }
  return best;
}

/** Picks the smallest single note that covers `amount`, else a two-note pair from one address. Null when one proof can't reach it. */
export function selectNotes(notes: readonly HeldNote[], asset: bigint, amount: bigint, processed: number, reserved: ReadonlySet<string>): readonly HeldNote[] | null {
  const usable = notes.filter((n) => n.asset === asset && n.leafIndex < processed && !reserved.has(toHex32(n.nullifier)));
  const single = usable.filter((n) => n.value >= amount).sort((a, b) => (a.value < b.value ? -1 : 1))[0];
  if (single) return [single];
  const byKey = new Map<number, HeldNote[]>();
  for (const n of usable) byKey.set(n.keyIndex, [...(byKey.get(n.keyIndex) ?? []), n]);
  for (const group of byKey.values()) {
    const top = [...group].sort((a, b) => (a.value < b.value ? 1 : -1)).slice(0, 2);
    if (top.length === 2 && top[0]!.value + top[1]!.value >= amount) return top;
  }
  return null;
}

function fundingHistory(chain: ChainState, h: HeldPosition): FundingEntry[] {
  const market = h.versions[0]!.pair.market;
  const m = chain.markets.find((x) => x.id === market);
  if (!m) return [];
  const out: FundingEntry[] = [];
  for (let i = 1; i < h.versions.length; i++) {
    const [p, next] = [h.versions[i - 1]!.pair, h.versions[i]!.pair];
    if (next.fundingIndex === p.fundingIndex) continue;
    const o = updateOutcome(p, { actor: ACTOR_NONE, add: 0n, remove: 0n, reduce: 0n }, 1n, 0n, m.scale, next.fundingIndex, 0n);
    out.push({ version: i, takerPays: next.debtByTaker === 1n || p.takerMargin > next.takerMargin, owed: o.fundingOwed, paid: o.fundingPaid, shortfall: next.fundingDebt });
  }
  return out;
}

/** The market data anyone can see, with no account open. */
export function buildPublicView(chain: ChainState, error: string | null): PrivateView {
  const dep = chain.deployment!;
  const assets = [...new Set([dep.asset.toLowerCase(), ...chain.pools.flatMap((p) => [p.token0.toLowerCase(), p.token1.toLowerCase()])])];
  return {
    unlocked: false,
    sync: { syncedBlock: chain.syncedBlock, head: chain.head, processed: chain.processed, queueLength: chain.queueLength, root: chain.root, updatedAt: Date.now(), error },
    chainNow: chain.chainNow, health: { readApi: true, relayer: !chain.relayerDown, rpc: true }, tokens: [...chain.tokens.values()], markets: chain.markets, pools: chain.pools, create: chain.create, exitBond: dep.exitBond, pool: dep.pool, relayerFee: chain.relayerFees,
    address: "", balances: assets.map((a) => ({ asset: a as Hex, free: 0n, arriving: 0n, largestSpendable: 0n, noteCount: 0 })), locks: [], positions: [], claims: [], lp: [], activity: [],
  };
}

export function buildView(chain: ChainState, d: Decoded, address: string, sync: { error: string | null }): PrivateView {
  const dep = chain.deployment!;
  const isSpent = (nf: bigint) => chain.spent.has(toHex32(nf));
  const now = chain.chainNow ?? 0n;
  const token = (asset: bigint): { symbol: string; decimals: number } => chain.tokens.get(hex20(asset)) ?? { symbol: "?", decimals: 18 };
  const amt = (asset: bigint, v: bigint): string => `${formatFixed(v, token(asset).decimals, 4)} ${token(asset).symbol}`;

  const assetSet = new Set<bigint>([BigInt(dep.asset), ...chain.pools.flatMap((p) => [BigInt(p.token0), BigInt(p.token1)]), ...d.notes.map((n) => n.asset)]);
  const balances: BalanceView[] = [...assetSet].map((asset) => {
    const held = d.notes.filter((n) => n.asset === asset);
    const inTree = held.filter((n) => n.leafIndex < chain.processed);
    return {
      asset: hex20(asset), free: inTree.reduce((s, n) => s + n.value, 0n), arriving: held.filter((n) => n.leafIndex >= chain.processed).reduce((s, n) => s + n.value, 0n),
      largestSpendable: largestPair(inTree).reduce((s, n) => s + n.value, 0n), noteCount: inTree.length,
    };
  });

  const positionsByKey = new Map(d.positions.map((p) => [p.keyIndex, p]));
  const locks: LockView[] = d.locks.map((h) => {
    const r = h.record;
    const inTree = h.leafIndex < chain.processed;
    const spent = isSpent(h.nullifier);
    const role = roleOf(r.role);
    const refund = d.allNotesByRho.get(outputRho(h.nullifier, 0n, 0));
    const released = spent && refund !== undefined && refund.asset === r.asset && refund.value === r.amount;
    const status = !inTree ? "queued" : spent ? (released ? "released" : "matched") : now > r.expiry ? "expired" : "live";
    return {
      id: toHex32(h.commitment), role, status, asset: hex20(r.asset), amount: r.amount, expiry: r.expiry, market: r.market, isShort: role === "taker" && r.t2 === 1n, size: r.t3, limit: r.t4, spreadBps: role === "maker" ? r.t2 : 0n,
      closeSpreadBps: role === "maker" ? r.t4 : 0n, secondPool: role === "swap" ? r.t4 : 0n, minOut: role === "swap" ? r.t3 : 0n,
    };
  });

  const positions: PositionView[] = d.positions.map((h) => {
    const last = h.versions.at(-1)!;
    const p = last.pair;
    const nf = toHex32(last.nullifier);
    const end = chain.ends.get(nf);
    const liveAfter = !isSpent(last.nullifier);
    const status = liveAfter ? "open" : end?.kind === "liquidated" ? "liquidated" : end?.mode === CLOSE_MATURED ? "forced" : "closed";
    const payoutNote = !liveAfter && end ? d.allNotesByRho.get(outputRho(last.nullifier, 0n, h.side === "taker" ? 0 : 1)) : undefined;
    const outcome = status === "open" ? null : { payout: payoutNote?.value ?? 0n, mark: end?.mark ?? null, mode: end?.mode ?? null, block: end?.block ?? null };
    return {
      id: h.id, side: h.side, status, market: p.market, asset: hex20(p.asset), isShort: p.isShort === 1n, size: p.size, entry: p.entry, closeSpreadBps: p.closeSpread, fundingIndex: p.fundingIndex, takerMargin: p.takerMargin, makerMargin: p.makerMargin,
      fundingDebt: p.fundingDebt, debtByTaker: p.debtByTaker === 1n, versions: h.versions.length, funding: fundingHistory(chain, h), exitMatureAt: chain.exits.get(nf) ?? null, outcome,
    };
  });

  const claims: ClaimView[] = d.claims.map((c) => ({
    id: toHex32(c.commitment), market: c.record.market, asset: hex20(c.record.asset), amount: c.record.amount, ratio: null,
    status: c.record.amount === 0n ? "none" : isSpent(c.nullifier) ? "redeemed" : "waiting",
  }));

  const lp: LpView[] = [];
  const liveLp = new Map<string, HeldLp>();
  for (const h of d.lps) if (!isSpent(h.nullifier)) liveLp.set(`${h.keys.pk.x}:${h.record.pool}`, h);
  for (const h of liveLp.values()) {
    lp.push({ id: toHex32(h.commitment), pool: h.record.pool, shares: h.record.shares, status: h.record.expiry === 0n ? "idle" : now > h.record.expiry ? "request_expired" : "removing", expiry: h.record.expiry, min0: h.record.min0, min1: h.record.min1 });
  }

  const activity = buildActivity(chain, d, positionsByKey, amt);

  return {
    unlocked: true,
    sync: { syncedBlock: chain.syncedBlock, head: chain.head, processed: chain.processed, queueLength: chain.queueLength, root: chain.root, updatedAt: Date.now(), error: sync.error },
    chainNow: chain.chainNow, health: { readApi: true, relayer: !chain.relayerDown, rpc: true }, tokens: [...chain.tokens.values()], markets: chain.markets, pools: chain.pools, create: chain.create, exitBond: dep.exitBond, pool: dep.pool, relayerFee: chain.relayerFees,
    address, balances, locks, positions, claims, lp, activity,
  };
}

/** Names what changed, in the owner's terms. Funding and owner actions can land in one update; the larger part names it. */
function describeUpdate(a: PairRecord, b: PairRecord, side: "taker" | "maker", scale: bigint | null, label: string, money: (v: bigint) => string): string {
  if (a.size !== b.size) return `Reduced ${label} by ${formatFixed(a.size - b.size, 18, 4)}`;
  const margin = (p: { takerMargin: bigint; makerMargin: bigint }) => (side === "taker" ? p.takerMargin : p.makerMargin);
  const settled = scale !== null && a.fundingIndex !== b.fundingIndex ? updateOutcome(a, { actor: ACTOR_NONE, add: 0n, remove: 0n, reduce: 0n }, 1n, 0n, scale, b.fundingIndex, 0n) : null;
  const afterFunding = settled ? margin(settled) : margin(a);
  const moved = margin(b) - afterFunding;
  if (moved > 0n) return `Added ${money(moved)} margin to ${label}`;
  if (moved < 0n) return `Removed ${money(-moved)} margin from ${label}`;
  const funding = margin(b) - margin(a);
  if (funding === 0n) return `Funding settled on ${label}, nothing owed`;
  return funding > 0n ? `Received ${money(funding)} funding on ${label}` : `Paid ${money(-funding)} funding on ${label}`;
}

function poolIcons(chain: ChainState, pool: bigint): { asset: Hex }[] {
  const p = chain.pools.find((x) => x.id === pool);
  return p ? [{ asset: p.token0 }, { asset: p.token1 }] : [];
}

function poolLabel(chain: ChainState, pool: bigint): string {
  const p = chain.pools.find((x) => x.id === pool);
  if (!p) return `pool ${pool}`;
  const symbol = (token: Hex) => chain.tokens.get(token.toLowerCase())?.symbol ?? "token";
  return `${symbol(p.token0)} / ${symbol(p.token1)}`;
}

/** What a deposit actually put in: each lock's amount less the excess the pool returned. Null until both refund notes are readable. */
function lpDeposited(d: Decoded, lp: HeldLp, isSpent: (nf: bigint) => boolean): readonly [{ asset: bigint; value: bigint }, { asset: bigint; value: bigint }] | null {
  const locks = d.locks.filter((x) => x.record.role === ROLE_LP && x.record.market === lp.record.pool && x.keys.pk.x === lp.keys.pk.x && isSpent(x.nullifier));
  for (const a of locks.filter((x) => x.record.t2 === 0n)) {
    for (const b of locks.filter((x) => x.record.t2 === 1n && x.record.t4 === a.record.t4)) {
      const refund0 = d.allNotesByRho.get(outputRho(a.nullifier, b.nullifier, 0));
      const refund1 = d.allNotesByRho.get(outputRho(a.nullifier, b.nullifier, 1));
      if (refund0 && refund1) return [{ asset: a.record.asset, value: a.record.amount - refund0.value }, { asset: b.record.asset, value: b.record.amount - refund1.value }];
    }
  }
  return null;
}

function buildActivity(chain: ChainState, d: Decoded, positions: ReadonlyMap<number, HeldPosition>, amt: (a: bigint, v: bigint) => string): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  const dep = chain.deployment!;
  const px = (v: bigint | null): string => (v === null ? "Unknown" : formatFixed(v, 18, 2));
  const spentAt = (nf: bigint) => chain.spent.get(toHex32(nf));

  const mineDeposits = d.allNotesByRho;
  const depositLeaves = new Set(chain.deposits.map((x) => x.leafIndex));
  const myConsumedBlocks = new Set<bigint>();
  const myConsumedTx = new Set<string>();
  for (const n of mineDeposits.values()) {
    const s = spentAt(n.nullifier);
    if (s) {
      myConsumedBlocks.add(s.block);
      myConsumedTx.add(s.tx.toLowerCase());
    }
  }
  for (const l of d.locks) {
    const s = spentAt(l.nullifier);
    if (s) myConsumedBlocks.add(s.block);
  }
  for (const n of mineDeposits.values()) {
    if (n.value === 0n) continue;
    if (depositLeaves.has(n.leafIndex)) {
      out.push({ icons: [{ asset: hex20(n.asset) }], id: `shield:${n.leafIndex}`, kind: "shield", title: `Shielded ${amt(n.asset, n.value)}`, detail: "Moved from a public wallet into your private balance. The deposit itself is public.", block: n.block, tx: null, fields: [{ label: "Amount", value: amt(n.asset, n.value) }] });
    } else if (n.keyIndex === -1 && !myConsumedBlocks.has(n.block)) {
      out.push({ icons: [{ asset: hex20(n.asset) }], id: `recv:${n.leafIndex}`, kind: "transfer_in", title: `Received ${amt(n.asset, n.value)}`, detail: "A private transfer to this account.", block: n.block, tx: null, fields: [{ label: "Amount", value: amt(n.asset, n.value) }] });
    }
  }
  for (const u of chain.unshields) {
    if (!myConsumedTx.has(u.tx.toLowerCase())) continue;
    out.push({ icons: [{ asset: u.asset }], id: `unshield:${u.tx}`, kind: "unshield", title: `Unshielded ${amt(BigInt(u.asset), u.amount)}`, detail: `Paid to ${getAddress(u.recipient)}. The amount and recipient are public.`, block: u.block, tx: u.tx, fields: [{ label: "Amount", value: amt(BigInt(u.asset), u.amount) }, { label: "Recipient", value: getAddress(u.recipient) }] });
  }
  for (const h of positions.values()) {
    const first = h.versions[0]!;
    const market = chain.markets.find((m) => m.id === first.pair.market);
    const label = market?.label ?? `Market ${first.pair.market}`;
    const sideWord = first.pair.isShort === 1n ? "short" : "long";
    const size = formatFixed(first.pair.size, 18, 4);
    const role = h.side === "maker" ? "Backed" : "Opened";
    out.push({
      icons: [{ market: first.pair.market }], id: `open:${h.id}`, kind: "open", title: `${role} ${sideWord} ${size} ${label}`, detail: `Filled at ${px(first.pair.entry)}.`, block: first.block, tx: null,
      fields: [{ label: "Size", value: `${size} ${label}` }, { label: "Entry", value: px(first.pair.entry) }, { label: "Your margin", value: amt(first.pair.asset, h.side === "taker" ? first.pair.takerMargin : first.pair.makerMargin) }],
    });
    for (let i = 1; i < h.versions.length; i++) {
      const [a, b] = [h.versions[i - 1]!, h.versions[i]!];
      const margin = (p: PairRecord) => (h.side === "taker" ? p.takerMargin : p.makerMargin);
      const changed = describeUpdate(a.pair, b.pair, h.side, market?.scale ?? null, label, (v) => amt(a.pair.asset, v));
      out.push({
        icons: [{ market: b.pair.market }], id: `upd:${h.id}:${i}`, kind: "update", title: changed, detail: "A new version of your position.", block: b.block, tx: null,
        fields: [{ label: "Size", value: formatFixed(b.pair.size, 18, 4) }, { label: "Margin before", value: amt(b.pair.asset, margin(a.pair)) }, { label: "Margin after", value: amt(b.pair.asset, margin(b.pair)) }],
      });
    }
    const last = h.versions.at(-1)!;
    const end = chain.ends.get(toHex32(last.nullifier));
    if (end) {
      const payout = d.allNotesByRho.get(outputRho(last.nullifier, 0n, h.side === "taker" ? 0 : 1))?.value ?? 0n;
      const fundingIndex = chain.fundingIndexAt(last.pair.market, end.block) ?? last.pair.fundingIndex;
      const fields = [{ label: "Paid out", value: amt(last.pair.asset, payout) }, { label: "Mark", value: px(end.mark) }];
      if (market && end.kind === "liquidated") {
        const o = liquidationOutcome(last.pair, end.mark, market.mmrWad, market.penaltyBps, market.scale, fundingIndex);
        fields.push({ label: "Penalty", value: amt(last.pair.asset, o.penalty) }, { label: "Funding paid", value: amt(last.pair.asset, o.fundingPaid) }, { label: "Funding shortfall", value: amt(last.pair.asset, o.fundingWrittenOff) });
      } else if (market && end.mode !== null) {
        const o = closeOutcome(last.pair, end.mode, end.mark, market.scale, fundingIndex, market.takerFeeBps);
        fields.push({ label: "Fill", value: px(o.fill) }, { label: "Fee", value: amt(last.pair.asset, o.fee) }, { label: "Funding paid", value: amt(last.pair.asset, o.fundingPaid) }, { label: "Short-paid", value: amt(last.pair.asset, o.shortPaid) });
      }
      out.push({ icons: [{ market: last.pair.market }], id: `end:${h.id}`, kind: end.kind === "liquidated" ? "liquidated" : end.mode === CLOSE_MATURED ? "forced" : "close", title: `${end.kind === "liquidated" ? "Liquidated" : end.mode === CLOSE_MATURED ? "Forced exit" : "Closed"} ${sideWord} ${formatFixed(last.pair.size, 18, 4)} ${label}, paid out ${amt(last.pair.asset, payout)}`, detail: `At mark ${px(end.mark)}.`, block: end.block, tx: end.tx, fields });
    }
  }
  for (const l of d.locks) {
    const s = spentAt(l.nullifier);
    const r = l.record;
    const out0 = d.allNotesByRho.get(outputRho(l.nullifier, 0n, 0));
    if (r.role === ROLE_SWAP && s) {
      if (out0 && out0.asset !== r.asset) out.push({ icons: [{ asset: hex20(r.asset) }, { asset: hex20(out0.asset) }], id: `swap:${toHex32(l.commitment)}`, kind: "swap", title: `Swapped ${amt(r.asset, r.amount)} for ${amt(out0.asset, out0.value)}`, detail: "Filled inside your minimum.", block: s.block, tx: s.tx, fields: [{ label: "Paid", value: amt(r.asset, r.amount) }, { label: "Received", value: amt(out0.asset, out0.value) }, { label: "Minimum accepted", value: amt(out0.asset, r.t3) }] });
      if (out0 && out0.asset === r.asset) out.push({ icons: [{ asset: hex20(r.asset) }], id: `refund:${toHex32(l.commitment)}`, kind: "refund", title: `Refunded ${amt(r.asset, r.amount)}`, detail: "An unfilled swap intent came back.", block: s.block, tx: s.tx, fields: [{ label: "Amount", value: amt(r.asset, r.amount) }] });
    } else if ((r.role === ROLE_TAKER || r.role === ROLE_MAKER) && s && out0 && out0.asset === r.asset && out0.value === r.amount) {
      out.push({ icons: [{ asset: hex20(r.asset) }], id: `refund:${toHex32(l.commitment)}`, kind: "refund", title: `Refunded ${amt(r.asset, r.amount)}`, detail: "An expired lock came back to you.", block: s.block, tx: s.tx, fields: [{ label: "Amount", value: amt(r.asset, r.amount) }] });
    }
  }
  const seenLp = new Set<string>();
  for (const l of d.lps) {
    if (l.record.expiry !== 0n || seenLp.has(`${l.keys.pk.x}`)) continue;
    seenLp.add(`${l.keys.pk.x}`);
    const name = poolLabel(chain, l.record.pool);
    const deposited = lpDeposited(d, l, (nf) => spentAt(nf) !== undefined);
    const amounts = deposited?.map((x) => amt(x.asset, x.value));
    out.push({ icons: poolIcons(chain, l.record.pool), id: `lp:${toHex32(l.commitment)}`, kind: "lp_add", title: amounts ? `Added ${amounts[0]} and ${amounts[1]} to ${name}` : `Added liquidity to ${name}`, detail: `${formatFixed(l.record.shares, 18, 6)} shares.`, block: l.block, tx: null, fields: [...(amounts ?? []).map((value) => ({ label: "Deposited", value })), { label: "Shares", value: formatFixed(l.record.shares, 18, 6) }] });
    const final = [...d.lps].reverse().find((x) => x.keys.pk.x === l.keys.pk.x)!;
    const s = spentAt(final.nullifier);
    if (s && final.record.expiry !== 0n) {
      const out0 = d.allNotesByRho.get(outputRho(final.nullifier, 0n, 0));
      const out1 = d.allNotesByRho.get(outputRho(final.nullifier, 0n, 1));
      if (out0 || out1) out.push({ icons: poolIcons(chain, final.record.pool), id: `lpout:${toHex32(final.commitment)}`, kind: "lp_remove", title: `Removed ${[out0, out1].flatMap((n) => (n ? [amt(n.asset, n.value)] : [])).join(" and ")} from ${name}`, detail: "Your share of the pool came back as private notes.", block: s.block, tx: s.tx, fields: [out0, out1].flatMap((n) => (n ? [{ label: "Received", value: amt(n.asset, n.value) }] : [])) });
    }
  }
  for (const c of d.claims) {
    if (c.record.amount === 0n) continue;
    const s = spentAt(c.nullifier);
    const redeemed = d.allNotesByRho.get(outputRho(c.nullifier, 0n, 0));
    if (s) out.push({ icons: [{ asset: hex20(c.record.asset) }], id: `claim:${toHex32(c.commitment)}`, kind: "claim", title: `Redeemed ${amt(c.record.asset, redeemed?.value ?? 0n)} claim`, detail: "Insurance paid the shortfall at the epoch's ratio.", block: s.block, tx: s.tx, fields: [{ label: "Claim", value: amt(c.record.asset, c.record.amount) }, { label: "Paid", value: amt(c.record.asset, redeemed?.value ?? 0n) }] });
  }
  return out.sort((a, b) => Number((b.block ?? 0n) - (a.block ?? 0n)));
}
