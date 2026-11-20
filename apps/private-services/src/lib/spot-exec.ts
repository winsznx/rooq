import {
  amountOut, EMPTY_POOL, inBand, releaseWitness, lockCommitment, lpAddOutcome, lpAddPrice, lpAddWitness, lpCommitment, LP_CT_LEN, lpRemoveWitness, lpSetWitness, openLp, openPoolStateWith, POOL_CT_LEN, RECORD_LP, recNullifier,
  ROLE_LP, ROLE_SWAP, swapWitness, sweepProtocolWitness,
  type HeldLock, type KeyRing, type LpRecord, type PoolInfo, type PoolState,
} from "@rooq/private-sdk";
import { bytesToHex, type SpotPoolInfo } from "./chain";
import { errorMessage } from "./log";
import type { Provers } from "./provers";
import type { Sender } from "./sender";
import type { ServiceContext } from "./service";
import { badRequest, ServiceError, type Reason } from "./errors";
import { json, RateLimiter, readJson, type RequestContext, type Route } from "./http";
import { countAfter } from "./key-health";
import { QUOTE_POOL_BUDGET_SCOPE } from "./quote-proxy";

const AS_OF_MARGIN = 120n;
const MAX_REPROVE = 4;
const QUOTE_SIG_DIGITS = 4;
const RETRYABLE: ReadonlySet<Reason> = new Set<Reason>(["UNKNOWN_ROOT", "INVALID_PROOF", "STALE_AS_OF", "RPC_UNAVAILABLE"]);

export interface LpHeld {
  readonly record: LpRecord;
  readonly leafIndex: number;
  readonly nullifier: bigint;
  readonly keyIndex: number;
}

/** `leaf` orders the work: an intent's own leaf, or for an LP add its first lock. */
export type SpotWork =
  | { kind: "swap"; leaf: number; lock: HeldLock; nullifier: bigint }
  | { kind: "add"; leaf: number; lock0: HeldLock; lock1: HeldLock; nullifiers: readonly [bigint, bigint] }
  | { kind: "remove"; leaf: number; held: LpHeld };

export interface SpotOrdering {
  readonly work: SpotWork[];
  /** First leaf of each linked LP lock pair that isn't at adjacent leaves. lp_add can never run it; it refunds at expiry. */
  readonly notAdjacent: readonly number[];
}

const lockNullifier = (deployment: bigint, h: HeldLock): bigint => recNullifier(lockCommitment(deployment, h.record), h.record.recNonce);

/**
 * Builds the round's work in tree order per pool. An LP add's two locks come from one lockPair call, which writes them at
 * adjacent leaves, and lp_add asserts that gap (#8). So no other intent can sit between them, an add orders by its first
 * lock, and nothing ever waits for a second lock. Locks pair by pool, link id and owner; the two price bounds differ.
 */
export function orderSpotWork(lockItems: readonly HeldLock[], removals: readonly LpHeld[], processed: number, deployment: bigint): SpotOrdering {
  const work: SpotWork[] = [];
  const notAdjacent: number[] = [];
  for (const h of lockItems) {
    if (h.record.role !== ROLE_SWAP || h.leafIndex >= processed) continue;
    work.push({ kind: "swap", leaf: h.leafIndex, lock: h, nullifier: lockNullifier(deployment, h) });
  }
  const groups = new Map<string, HeldLock[]>();
  for (const h of lockItems) {
    if (h.record.role !== ROLE_LP) continue;
    const key = `${h.record.market}:${h.record.t4}:${h.record.ownerAuth}`;
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  for (const group of groups.values()) {
    const sideOne = new Map(group.filter((h) => h.record.t2 === 1n).map((h) => [h.leafIndex, h]));
    for (const lock0 of group.filter((h) => h.record.t2 === 0n)) {
      const lock1 = sideOne.get(lock0.leafIndex + 1);
      if (!lock1) {
        if (sideOne.size > 0) notAdjacent.push(lock0.leafIndex);
        continue;
      }
      if (lock1.leafIndex >= processed) continue;
      work.push({ kind: "add", leaf: lock0.leafIndex, lock0, lock1, nullifiers: [lockNullifier(deployment, lock0), lockNullifier(deployment, lock1)] });
    }
  }
  for (const held of removals) work.push({ kind: "remove", leaf: held.leafIndex, held });
  work.sort((a, b) => a.leaf - b.leaf);
  return { work, notAdjacent };
}

/** One hop of a quote, as the pool's reserves in the direction of the trade. */
export interface QuoteHop {
  readonly rIn: bigint;
  readonly rOut: bigint;
  readonly feeBps: bigint;
}

/**
 * Fraction of the pre-trade mid price lost to the curve (fee excluded), in bps. It reads only reserves cut to four
 * significant figures, so searching amountIn for an edge in the answer solves the reserves to no more than the rounded
 * amountOut already shows (SPOT-05).
 */
export function coarseImpactBps(hops: readonly QuoteHop[], amountIn: bigint): number {
  let amount = amountIn;
  let impact = 1_000_000n;
  for (const h of hops) {
    const rIn = roundDownSig(h.rIn, QUOTE_SIG_DIGITS);
    const rOut = roundDownSig(h.rOut, QUOTE_SIG_DIGITS);
    impact = (impact * ((rIn * 10_000n * 1_000_000n) / (rIn * 10_000n + amount * (10_000n - h.feeBps)))) / 1_000_000n;
    amount = amountOut(amount, rIn, rOut, h.feeBps);
  }
  return 1_000_000n > impact ? Number((1_000_000n - impact) / 100n) : 0;
}

type Planned = { ok: true; asOf: bigint } | { ok: false; reason: string };

export interface Quote {
  readonly amountOut: bigint;
  readonly priceImpactBps: number;
  readonly hops: number;
}

/** Keeps a few leading digits and rounds down, so a quoted amount is still executable and reserves are not read exactly. */
function roundDownSig(x: bigint, digits: number): bigint {
  const s = x.toString();
  if (s.length <= digits) return x;
  const scale = 10n ** BigInt(s.length - digits);
  return (x / scale) * scale;
}

/**
 * Executes spot intents in increasing tree order per pool (D-18), for any service that holds a pool key. Slot picks that
 * service's copy of the pool ciphertext: coordinator 0, risk A 1, risk B 2. Anything unfillable is skipped with a logged
 * reason and left to expire. The proof fixes every outcome, so executing only ever helps the intent's owner.
 */
export class SpotExecutor {
  private readonly stateCache = new Map<bigint, { state: PoolState; keyIndex: number }>();
  private readonly lpCache = new Map<bigint, { value: LpRecord; keyIndex: number } | null>();
  private readonly reported = new Set<string>();
  private generation = -1;
  private scanned = 0;
  private lps: { record: LpRecord; leafIndex: number; keyIndex: number }[] = [];
  /** Block of each LP record no held key opens, in chain order. */
  private unreadableLpBlocks: bigint[] = [];
  private readonly quoteCache = new Map<bigint, { state: PoolState; at: number }>();
  private readonly quoteCacheMs: number;
  private lastPending = 0;
  private readonly minExpiryMargin = BigInt(process.env.SPOT_MIN_EXPIRY_MARGIN_S ?? 20);
  private readonly sweepIntervalMs = Number(process.env.SPOT_SWEEP_INTERVAL_S ?? 86_400) * 1000;
  private readonly lastSweep = new Map<bigint, number>();

  constructor(
    private readonly ctx: ServiceContext,
    private readonly ring: KeyRing,
    private readonly poolSlot: number,
    private readonly lpSlot: number,
    private readonly sender: Sender,
    private readonly provers: Provers,
  ) {
    this.quoteCacheMs = Number(process.env.SPOT_QUOTE_CACHE_MS ?? 15_000);
  }

  get pending(): number {
    return this.lastPending;
  }

  private get keys(): readonly [{ x: bigint; y: bigint }, { x: bigint; y: bigint }, { x: bigint; y: bigint }] {
    const { chain } = this.ctx;
    return [chain.coordinator, chain.riskKeys[0], chain.riskKeys[1]];
  }

  poolState(id: bigint): PoolState {
    const last = this.ctx.ledger.latestSpotUpdate(id);
    if (!last) return EMPTY_POOL;
    const opened = this.openedPool(id, last);
    if (!opened) throw new Error(`pool ${id} ciphertext does not open to its head with any held key`);
    return opened.state;
  }

  private openedPool(id: bigint, last: { head: bigint; ciphertext: readonly bigint[] }): { state: PoolState; keyIndex: number } | null {
    let opened = this.stateCache.get(last.head);
    if (!opened) {
      const hit = openPoolStateWith(this.ring, last.ciphertext.slice(this.poolSlot * POOL_CT_LEN, (this.poolSlot + 1) * POOL_CT_LEN), this.ctx.chain.deploymentId, id, last.head);
      if (!hit) return null;
      opened = { state: hit.value, keyIndex: hit.keyIndex };
      this.stateCache.set(last.head, opened);
    }
    return opened;
  }

  /**
   * Records this service can only read with a key other than `currentKeyIndex`: pools not yet touched since the rotation and
   * open LP requests, queued ones included. An LP record no key opens counts as unreadable only when it landed after
   * `currentKeySince`, since older ones are expected to go dark once a retired key is destroyed.
   */
  retiredKeyRecords(currentKeyIndex: number, currentKeySince: bigint): { retired: number; unreadable: number } {
    let retired = 0;
    let unreadablePools = 0;
    for (const p of this.ctx.chain.spotPools) {
      const last = this.ctx.ledger.latestSpotUpdate(p.id);
      if (!last) continue;
      const opened = this.openedPool(p.id, last);
      if (!opened) unreadablePools++;
      else if (opened.keyIndex !== currentKeyIndex) retired++;
    }
    for (const lp of this.unspentLps(true)) {
      if (lp.keyIndex !== currentKeyIndex && lp.record.expiry !== 0n) retired++;
    }
    return { retired, unreadable: countAfter(this.unreadableLpBlocks, currentKeySince) + unreadablePools };
  }

  private info(p: SpotPoolInfo): PoolInfo {
    const last = this.ctx.ledger.latestSpotUpdate(p.id);
    return { ...p, state: this.poolState(p.id), head: last?.head ?? 0n };
  }

  scanLps(): void {
    const { ledger, chain } = this.ctx;
    if (ledger.generation !== this.generation) {
      this.generation = ledger.generation;
      this.scanned = 0;
      this.lps = [];
      this.unreadableLpBlocks = [];
    }
    for (; this.scanned < ledger.records.length; this.scanned++) {
      const r = ledger.records[this.scanned]!;
      if (r.kind !== RECORD_LP) continue;
      let lp = this.lpCache.get(r.commitment);
      if (lp === undefined) {
        lp = this.ring.open((sk) => openLp(r.ciphertext.slice(this.lpSlot * LP_CT_LEN, (this.lpSlot + 1) * LP_CT_LEN), sk, chain.deploymentId, r.commitment));
        this.lpCache.set(r.commitment, lp);
      }
      if (lp) this.lps.push({ record: lp.value, leafIndex: r.leafIndex, keyIndex: lp.keyIndex });
      else this.unreadableLpBlocks.push(r.block);
    }
  }

  private unspentLps(includeQueued = false): LpHeld[] {
    const { ledger, chain } = this.ctx;
    const out: LpHeld[] = [];
    for (const { record, leafIndex, keyIndex } of this.lps) {
      if (!includeQueued && leafIndex >= ledger.processed) continue;
      const nullifier = recNullifier(lpCommitment(chain.deploymentId, record), record.recNonce);
      if (!ledger.isSpent(nullifier)) out.push({ record, leafIndex, nullifier, keyIndex });
    }
    return out;
  }

  /** Open removal requests that have not expired, and those that have. */
  removals(now: bigint): { open: LpHeld[]; expired: LpHeld[] } {
    const open: LpHeld[] = [];
    const expired: LpHeld[] = [];
    for (const h of this.unspentLps()) {
      if (h.record.expiry === 0n) continue;
      if (h.record.expiry >= now) open.push(h);
      else expired.push(h);
    }
    return { open, expired };
  }

  /** Mode 1 of lp_set needs no key, so any service can return an expired request to idle. */
  async returnToIdle(held: LpHeld, now: bigint): Promise<void> {
    const { chain, ledger, log } = this.ctx;
    const w = lpSetWitness({ claim: held.record, leafIndex: held.leafIndex, deployment: chain.deploymentId, tree: ledger.tree, mode: 1n, sk: 0n, priceLo: 0n, priceHi: 0n, expiry: 0n, asOf: now, keys: this.keys });
    let proof;
    try {
      proof = await (await this.provers.get("lp_set")).prove(w.inputs);
    } catch (error) {
      log.warn("lp_idle_proof_refused", { message: errorMessage(error) });
      return;
    }
    const outcome = await this.sender.send("setLiquidityRequest", [bytesToHex(proof.proof), { ...w.publicInputs }]);
    if (outcome.status === "confirmed") {
      this.ctx.bump("lpRequestsIdled");
      this.ctx.recordAction("lpReturnToIdle", outcome.hash);
    } else if (outcome.status !== "timeout" && outcome.revert.reason === "NULLIFIER_SPENT") {
      this.ctx.bump("lostRaces");
    }
  }

  /** Runs everything executable in tree order; a later position in a pool can never be ahead of an earlier one. */
  async execute(lockItems: readonly HeldLock[], removals: readonly LpHeld[], now: bigint): Promise<number> {
    await this.ctx.chain.refreshProtocolShares();
    const { work, notAdjacent } = orderSpotWork(lockItems, removals, this.ctx.ledger.processed, this.ctx.chain.deploymentId);
    for (const leaf of notAdjacent) this.note({ kind: "add", leaf }, "NOT_ADJACENT");
    let executed = 0;
    for (const item of work) {
      if (await this.runOne(item, now)) executed++;
    }
    this.lastPending = work.length - executed;
    return executed;
  }

  /**
   * Pays a pool's protocol accruals to the deployment fee address. Only a pool with a nonzero accrual is swept, at most once per
   * SPOT_SWEEP_INTERVAL_S, so a share of zero (every pool today) never costs a transaction. A sweep leaves reserves and
   * `lastLeaf` alone, so it can't strand an intent; a head moved under it is just tried again next round.
   */
  async sweepProtocolFees(): Promise<void> {
    const { chain, ledger, log } = this.ctx;
    for (const p of chain.spotPools) {
      if (Date.now() - (this.lastSweep.get(p.id) ?? 0) < this.sweepIntervalMs) continue;
      // Set before the read, so a pool no held key opens is tried once per interval and never stops the rest of the tick. A
      // readable pool with nothing accrued clears it again, so a new accrual is seen on the next tick.
      this.lastSweep.set(p.id, Date.now());
      const last = ledger.latestSpotUpdate(p.id);
      const opened = last ? this.openedPool(p.id, last) : { state: EMPTY_POOL };
      if (!opened) {
        log.warn("sweep_protocol_pool_unreadable", { pool: p.id });
        continue;
      }
      if (opened.state.proto0 === 0n && opened.state.proto1 === 0n) {
        this.lastSweep.delete(p.id);
        continue;
      }
      const pool: PoolInfo = { ...p, state: opened.state, head: last?.head ?? 0n };
      const w = sweepProtocolWitness({ pool, deployment: chain.deploymentId, feeTo: chain.feeTo, keys: this.keys });
      let proof;
      try {
        proof = await (await this.provers.get("sweep_protocol")).prove(w.inputs);
      } catch (error) {
        log.warn("sweep_protocol_proof_refused", { pool: p.id, message: errorMessage(error) });
        continue;
      }
      const outcome = await this.sender.send("sweepProtocolFees", [bytesToHex(proof.proof), { ...w.publicInputs }]);
      if (outcome.status === "confirmed") {
        this.ctx.bump("protocolSweeps");
        this.ctx.recordAction("sweepProtocolFees", outcome.hash);
        await this.ctx.ledger.sync();
      } else if (outcome.status !== "timeout") {
        log.info("sweep_protocol_failed", { pool: p.id, reason: outcome.revert.reason });
        this.lastSweep.delete(p.id);
      }
    }
  }

  private note(item: Pick<SpotWork, "kind" | "leaf">, reason: string): void {
    const key = `${item.kind}:${item.leaf}:${reason}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.ctx.bump("spotSkips");
    this.ctx.log.info("spot_intent_skipped", { kind: item.kind, reason });
  }

  private isConsumed(item: SpotWork): boolean {
    const { ledger } = this.ctx;
    if (item.kind === "swap") return ledger.isSpent(item.nullifier);
    if (item.kind === "add") return ledger.isSpent(item.nullifiers[0]) || ledger.isSpent(item.nullifiers[1]);
    return ledger.isSpent(item.held.nullifier);
  }

  private plan(item: SpotWork, now: bigint): Planned {
    const { chain } = this.ctx;
    const expiry = item.kind === "swap" ? item.lock.record.expiry : item.kind === "add" ? minBig(item.lock0.record.expiry, item.lock1.record.expiry) : item.held.record.expiry;
    if (expiry - now < this.minExpiryMargin) return { ok: false, reason: "NEAR_EXPIRY" };
    const asOf = now + AS_OF_MARGIN < expiry ? now + AS_OF_MARGIN : expiry;
    if (item.kind === "swap") {
      const r = item.lock.record;
      const leaf = BigInt(item.leaf) + 1n;
      const first = chain.spotPool(r.market);
      if (!first) return { ok: false, reason: "UNKNOWN_POOL" };
      const second = r.t4 !== 0n ? chain.spotPool(r.t4) : undefined;
      if (r.t4 !== 0n && !second) return { ok: false, reason: "UNKNOWN_POOL" };
      let amount = r.amount;
      let asset = r.asset;
      for (const p of [first, ...(second ? [second] : [])]) {
        const s = this.poolState(p.id);
        if (s.supply === 0n) return { ok: false, reason: "POOL_EMPTY" };
        if (s.lastLeaf >= leaf) return { ok: false, reason: "OUT_OF_ORDER" };
        const zeroForOne = asset === p.token0;
        if (!zeroForOne && asset !== p.token1) return { ok: false, reason: "ASSET_NOT_IN_POOL" };
        const [rIn, rOut] = zeroForOne ? [s.r0, s.r1] : [s.r1, s.r0];
        amount = amountOut(amount, rIn, rOut, p.feeBps);
        asset = zeroForOne ? p.token1 : p.token0;
        if (amount === 0n) return { ok: false, reason: "ZERO_OUTPUT" };
      }
      if (amount < r.t3) return { ok: false, reason: "BELOW_MIN_OUT" };
      return { ok: true, asOf };
    }
    if (item.kind === "add") {
      const a = item.lock0.record;
      const b = item.lock1.record;
      if (a.t4 !== b.t4 || a.ownerX !== b.ownerX) return { ok: false, reason: "LOCKS_NOT_LINKED" };
      if (item.lock1.leafIndex !== item.lock0.leafIndex + 1) return { ok: false, reason: "NOT_ADJACENT" };
      const p = chain.spotPool(a.market);
      if (!p) return { ok: false, reason: "UNKNOWN_POOL" };
      if (a.asset !== p.token0 || b.asset !== p.token1) return { ok: false, reason: "WRONG_ASSETS" };
      const s = this.poolState(p.id);
      if (s.lastLeaf >= BigInt(item.lock0.leafIndex) + 1n) return { ok: false, reason: "OUT_OF_ORDER" };
      const [p0, p1] = lpAddPrice(a.amount, b.amount, s);
      if (!inBand(p0, p1, a.t3, b.t3)) return { ok: false, reason: "OUTSIDE_PRICE_BAND" };
      if (lpAddOutcome(a.amount, b.amount, s).shares === 0n) return { ok: false, reason: "ZERO_SHARES" };
      return { ok: true, asOf };
    }
    const c = item.held.record;
    const p = chain.spotPool(c.pool);
    if (!p) return { ok: false, reason: "UNKNOWN_POOL" };
    const s = this.poolState(p.id);
    if (s.lastLeaf >= BigInt(item.leaf) + 1n) return { ok: false, reason: "OUT_OF_ORDER" };
    if (s.supply === 0n || c.shares > s.supply) return { ok: false, reason: "EMPTY_POOL" };
    if (!inBand(s.r0, s.r1, c.priceLo, c.priceHi)) return { ok: false, reason: "OUTSIDE_PRICE_BAND" };
    return { ok: true, asOf };
  }

  /** One item: plan, prove, submit. A moved head just means re-planning against the new state and proving again. */
  private async runOne(item: SpotWork, now: bigint): Promise<boolean> {
    const { ledger, log, chain } = this.ctx;
    for (let attempt = 1; attempt <= MAX_REPROVE; attempt++) {
      if (attempt > 1) {
        await ledger.sync();
        await chain.refreshKeys();
        await chain.refreshProtocolShares(true);
      }
      if (this.isConsumed(item)) return false;
      const planned = this.plan(item, attempt > 1 ? await chain.blockTime() : now);
      if (!planned.ok) {
        this.note(item, planned.reason);
        return false;
      }
      const built = this.witness(item, planned.asOf);
      let proof;
      try {
        proof = await (await this.provers.get(built.circuit)).prove(built.inputs);
      } catch (error) {
        log.warn("spot_proof_refused", { kind: item.kind, message: errorMessage(error) });
        this.note(item, "PROOF_REFUSED");
        return false;
      }
      const outcome = await this.sender.send(built.fn, [bytesToHex(proof.proof), built.publicInputs]);
      if (outcome.status === "confirmed") {
        this.ctx.bump(`spot_${item.kind}`);
        this.ctx.recordAction(`spot:${item.kind}`, outcome.hash);
        log.info("spot_executed", { kind: item.kind, tx: outcome.hash, attempt });
        await ledger.sync();
        return true;
      }
      if (outcome.status === "timeout") return false;
      if (RETRYABLE.has(outcome.revert.reason)) {
        this.ctx.bump("reproved");
        log.info("spot_reproving", { kind: item.kind, reason: outcome.revert.reason, attempt });
        continue;
      }
      if (outcome.revert.reason === "NULLIFIER_SPENT") {
        this.ctx.bump("lostRaces");
        return false;
      }
      this.note(item, outcome.revert.reason);
      return false;
    }
    this.note(item, "REPROVE_LIMIT");
    return false;
  }

  private witness(item: SpotWork, asOf: bigint): { circuit: string; fn: string; inputs: Parameters<Awaited<ReturnType<Provers["get"]>>["prove"]>[0]; publicInputs: Record<string, unknown> } {
    const { chain, ledger } = this.ctx;
    const deployment = chain.deploymentId;
    const tree = ledger.tree;
    if (item.kind === "swap") {
      const r = item.lock.record;
      const first = this.info(chain.spotPool(r.market)!);
      const pools: [PoolInfo] | [PoolInfo, PoolInfo] = r.t4 !== 0n ? [first, this.info(chain.spotPool(r.t4)!)] : [first];
      const w = swapWitness({ held: item.lock, deployment, tree, pools, asOf, keys: this.keys });
      return { circuit: "swap", fn: "swap", inputs: w.inputs, publicInputs: { ...w.publicInputs } };
    }
    if (item.kind === "add") {
      const w = lpAddWitness({ lock0: item.lock0, lock1: item.lock1, pool: this.info(chain.spotPool(item.lock0.record.market)!), deployment, tree, asOf, keys: this.keys });
      return { circuit: "lp_add", fn: "addLiquidity", inputs: w.inputs, publicInputs: { ...w.publicInputs } };
    }
    const c = item.held;
    const w = lpRemoveWitness({ claim: c.record, leafIndex: c.leafIndex, pool: this.info(chain.spotPool(c.record.pool)!), deployment, tree, asOf, keys: this.keys });
    return { circuit: "lp_remove", fn: "removeLiquidity", inputs: w.inputs, publicInputs: { ...w.publicInputs } };
  }

  /**
   * An executable estimate without reserves. It reads state from a cached snapshot and rounds down, so a burst of
   * quotes cannot time one trade's delta or solve the reserves to full precision. See the SPOT-05 note in the report.
   */
  hasPool(id: bigint): boolean {
    return this.ctx.chain.spotPool(id) !== undefined;
  }

  quote(firstPool: bigint, secondPool: bigint, assetIn: bigint, amountIn: bigint): Quote | { refused: Reason; message: string } {
    const { chain } = this.ctx;
    const pools = [chain.spotPool(firstPool), ...(secondPool !== 0n ? [chain.spotPool(secondPool)] : [])];
    if (pools.some((p) => !p)) return { refused: "UNKNOWN_POOL", message: "No such pool." };
    const snapshot = (id: bigint): PoolState => {
      const cached = this.quoteCache.get(id);
      if (cached && Date.now() - cached.at < this.quoteCacheMs) return cached.state;
      const state = this.poolState(id);
      this.quoteCache.set(id, { state, at: Date.now() });
      return state;
    };
    let amount = amountIn;
    let asset = assetIn;
    const hops: QuoteHop[] = [];
    for (const p of pools as SpotPoolInfo[]) {
      const s = snapshot(p.id);
      if (s.supply === 0n) return { refused: "POOL_EMPTY", message: "This pool has no liquidity." };
      const zeroForOne = asset === p.token0;
      if (!zeroForOne && asset !== p.token1) return { refused: "ASSET_NOT_IN_POOL", message: "Asset is not in this pool." };
      const [rIn, rOut] = zeroForOne ? [s.r0, s.r1] : [s.r1, s.r0];
      const out = amountOut(amount, rIn, rOut, p.feeBps);
      if (out === 0n) return { refused: "ASSET_NOT_IN_POOL", message: "The amount is too small for this pool." };
      hops.push({ rIn, rOut, feeBps: p.feeBps });
      amount = out;
      asset = zeroForOne ? p.token1 : p.token0;
    }
    return { amountOut: roundDownSig(amount, QUOTE_SIG_DIGITS), priceImpactBps: coarseImpactBps(hops, amountIn), hops: pools.length };
  }
}

/** Any service that can read an expired lock returns it to its owner; only the committed owner can receive it. */
export async function releaseExpiredLocks(ctx: ServiceContext, sender: Sender, provers: Provers, locks: readonly HeldLock[], now: bigint, delaySeconds: bigint, budget = 6): Promise<void> {
  const { ledger, chain, log } = ctx;
  let left = budget;
  for (const h of locks) {
    if (left === 0 || h.record.expiry + delaySeconds > now || h.leafIndex >= ledger.processed) continue;
    if (ledger.isSpent(recNullifier(lockCommitment(chain.deploymentId, h.record), h.record.recNonce))) continue;
    left--;
    const w = releaseWitness({ held: h, deployment: chain.deploymentId, tree: ledger.tree, asOf: now });
    let proof;
    try {
      proof = await (await provers.get("release")).prove(w.inputs);
    } catch (error) {
      log.warn("release_proof_refused", { message: errorMessage(error) });
      continue;
    }
    const outcome = await sender.send("release", [bytesToHex(proof.proof), { ...w.publicInputs }]);
    if (outcome.status === "confirmed") {
      ctx.bump("locksReleased");
      ctx.recordAction("release", outcome.hash);
    } else if (outcome.status !== "timeout") {
      if (outcome.revert.reason === "NULLIFIER_SPENT") ctx.bump("lostRaces");
      else log.warn("release_failed", { reason: outcome.revert.reason });
    }
  }
}

const QUOTE_POOL_BUDGET_PER_MINUTE = Number(process.env.SPOT_QUOTE_POOL_BUDGET ?? 240);

function parseQuoteAmount(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(\d{1,40}|0x[0-9a-fA-F]{1,40})$/.test(value)) throw badRequest(`${field} must be a decimal or 0x hex string.`);
  return BigInt(value);
}

/**
 * The quote route, served by whichever service holds a pool key (the read API proxies to it and stays keyless). The
 * per-client limit is the HTTP layer's; this adds a per-pool budget across all clients, which is what actually bounds
 * how fast anyone can sample one pool, since one client behind many addresses still shares it. A routed quote samples both
 * pools, so it is charged to both and refused when either is spent. The per-client limit keys on the caller the read API
 * names in X-Forwarded-For (with TRUST_PROXY=1), so its users don't share one bucket.
 */
export function quoteRoute(spot: Pick<SpotExecutor, "hasPool" | "quote">): Route {
  const budget = new RateLimiter();
  let prunedAt = Date.now();
  return {
    method: "POST",
    pattern: "/v1/spot/quote",
    perMinute: Number(process.env.SPOT_QUOTE_PER_MINUTE ?? 30),
    handler: async ({ req }: RequestContext) => {
      const body = await readJson(req, 4 * 1024);
      const pool = parseQuoteAmount(body.pool, "pool");
      const secondPool = body.secondPool === undefined ? 0n : parseQuoteAmount(body.secondPool, "secondPool");
      const amountIn = parseQuoteAmount(body.amountIn, "amountIn");
      if (amountIn === 0n) throw badRequest("amountIn must be positive.");
      if (typeof body.assetIn !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.assetIn)) throw badRequest("assetIn must be a 20-byte hex address.");
      // Only known pools reach the budget, so its keys are bounded by the pool list, not by what callers send.
      if (!spot.hasPool(pool) || (secondPool !== 0n && !spot.hasPool(secondPool))) throw new ServiceError(422, "UNKNOWN_POOL", "No such pool.", false);
      const now = Date.now();
      if (now - prunedAt >= 60_000) {
        budget.prune(now);
        prunedAt = now;
      }
      const touched = secondPool === 0n ? [pool.toString()] : [pool.toString(), secondPool.toString()];
      if (!budget.allowAll(touched, QUOTE_POOL_BUDGET_PER_MINUTE, now)) {
        throw new ServiceError(429, "RATE_LIMITED", "Quotes for this pool are rate limited. Try again shortly.", true, { scope: QUOTE_POOL_BUDGET_SCOPE });
      }
      const result = spot.quote(pool, secondPool, BigInt(body.assetIn), amountIn);
      if ("refused" in result) throw new ServiceError(422, result.refused, result.message, false);
      return json({ pool, secondPool, amountOut: result.amountOut, priceImpactBps: result.priceImpactBps, hops: result.hops, indicative: true });
    },
  };
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

