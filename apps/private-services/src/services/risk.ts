/**
 * One risk worker (A or B). A separate process with its own key and no shared state: everything comes from the chain and
 * the risk keys it holds (LIQ-04, D-24). Either worker alone can discover pairs, liquidate, advance and fold funding, settle funding with
 * no owner key, and close matured forced exits. The shared nullifier means a lost race is expected, not an error.
 */
import {
  ACTOR_NONE, addressOf, BPS, MIN_UPDATE_GAP, nextUpdateAt, OI_CLOSE, OI_OPEN, OI_REDUCE, bondReleaseWitness, claimCommitment, KeyRing, LOCK_CT_LEN, openLock, insuranceSweepWitness, lockCommitment, redeemWitness, RECORD_LOCK, ROLE_LP, ROLE_SWAP, toHex32, CLAIM_CT_LEN, CLOSE_DEAD_ORACLE, CLOSE_MATURED, closeWitness, deriveKeys, fundingEpochWitness, liquidateWitness, liquidationOutcome, MARKET_CT_LEN, OI_BATCH, openClaim, openMarketState, openPair, oiDeltaCommitment, PAIR_CT_LEN, pairCommitment,
  randomField, RECORD_CLAIM, RECORD_PAIR, recNullifier, updateOutcome, updateWitness,
  type ClaimRecord, type HeldLock, type LockRecord, type MarketState, type OiDelta, type PairRecord, type PrivateAddress, type RingHit,
} from "@rooq/private-sdk";
import { bytesToHex, type MarketInfo, type PriceRead } from "../lib/chain";
import { intEnv, PORTS, takePrivateKey, takeScalar, takeScalarList } from "../lib/config";
import { Provers } from "../lib/provers";
import { errorMessage } from "../lib/log";
import { processQueueOnce } from "../lib/queue-step";
import { Sender, type TxOutcome } from "../lib/sender";
import { runService, type ServiceContext } from "../lib/service";
import type { Reason } from "../lib/errors";
import type { Route } from "../lib/http";
import { countAfter, currentKeySince, retiredDeltas, retiredUnspent, type DeltaSource } from "../lib/key-health";
import { quoteRoute, releaseExpiredLocks, SpotExecutor, type LpHeld } from "../lib/spot-exec";

type WorkerId = "A" | "B";

interface HeldPair {
  readonly pair: PairRecord;
  readonly leafIndex: number;
  readonly nullifier: bigint;
  readonly keyIndex: number;
}

const RACE_REASONS: ReadonlySet<Reason> = new Set<Reason>(["NULLIFIER_SPENT"]);
/** The lineage froze under the proof: a matured exit request now owns it, and the forced close takes over. */
const FROZEN_REASONS: ReadonlySet<Reason> = new Set<Reason>(["EXIT_MATURED"]);
const RETRY_REASONS: ReadonlySet<Reason> = new Set<Reason>(["INVALID_PROOF", "UNKNOWN_ROOT", "STALE_AS_OF", "RPC_UNAVAILABLE"]);
const ORACLE_DEAD_AFTER = 14n * 86_400n;
const INSURANCE_SWEEP_AFTER = 90n * 86_400n;

const KEYLESS_UPDATE = { actor: ACTOR_NONE, add: 0n, remove: 0n, reduce: 0n } as const;

class RiskWorker {
  private readonly slotPair: number;
  private readonly slotClaim: number;
  private readonly slotMarket: number;
  private readonly riskSlot: 0 | 1;
  private readonly pairCache = new Map<bigint, RingHit<PairRecord> | null>();
  private readonly claimCache = new Map<bigint, RingHit<ClaimRecord> | null>();
  private readonly marketStates = new Map<bigint, RingHit<MarketState>>();
  /** Block of each lock, pair and claim record no held key opens, in chain order. */
  private unreadableBlocks: bigint[] = [];
  /** OI delta commitments by `market:index`. A queue entry never changes, so each is read once per ledger generation. */
  private readonly deltaCache = new Map<string, bigint>();
  /** Unfolded delta commitments per market, as of the last tick, for key health. */
  private readonly pendingDeltas = new Map<bigint, readonly bigint[]>();
  private generation = -1;
  private scanned = 0;
  private pairs: { record: PairRecord; leafIndex: number; keyIndex: number }[] = [];
  private claims: { record: ClaimRecord; leafIndex: number; keyIndex: number }[] = [];
  private readonly claimDueSince = new Map<bigint, number>();
  private readonly lpDueSince = new Map<bigint, number>();
  private readonly lockCache = new Map<bigint, RingHit<LockRecord> | null>();
  private locks: (HeldLock & { readonly keyIndex: number })[] = [];
  private readonly migrateBudget: number;
  private readonly lockDueSince = new Map<number, number>();
  private readonly lockSlot: number;
  private readonly releaseDelaySeconds: bigint;
  private readonly claimRedeemDelayMs: number;
  private readonly spotTakeoverMs: number;
  readonly spot: SpotExecutor;
  private backoff = new Map<string, number>();
  private readonly epochIntervalSeconds: bigint;
  private readonly foldGapSeconds: bigint;
  private readonly staggerSeconds: bigint;
  private readonly settleMinBps: bigint;
  private readonly queueFallbackMs: number;
  private queueBacklogSince: number | null = null;
  private readonly settleDueSince = new Map<bigint, number>();
  /** When each market's queue last filled a batch, keyed to the fold count it was seen at. */
  private readonly batchFullSince = new Map<bigint, { consumed: bigint; at: number }>();

  constructor(
    private readonly ctx: ServiceContext,
    id: WorkerId,
    private readonly ring: KeyRing,
    private readonly rewardTo: PrivateAddress,
    private readonly sender: Sender,
    private readonly provers: Provers,
    /** PrivatePairs.MIN_UPDATE_GAP: a keyless update of a pair waits this long after its last version. */
    private readonly minGap: bigint,
  ) {
    this.riskSlot = id === "A" ? 0 : 1;
    this.slotPair = id === "A" ? 2 : 3;
    this.slotClaim = id === "A" ? 1 : 2;
    this.slotMarket = id === "A" ? 1 : 2;
    this.lockSlot = id === "A" ? 2 : 3;
    this.releaseDelaySeconds = BigInt(intEnv(process.env, "RISK_RELEASE_DELAY_S", 3_600, 0));
    this.epochIntervalSeconds = BigInt(intEnv(process.env, "RISK_EPOCH_INTERVAL_S", 300, 1));
    this.foldGapSeconds = BigInt(intEnv(process.env, "RISK_FOLD_GAP_S", 30, 1));
    this.staggerSeconds = BigInt(intEnv(process.env, "RISK_STAGGER_S", id === "A" ? 0 : 15));
    this.settleMinBps = BigInt(intEnv(process.env, "RISK_SETTLE_MIN_BPS", 100, 0));
    this.queueFallbackMs = intEnv(process.env, "RISK_QUEUE_FALLBACK_MS", 30_000, 0);
    this.claimRedeemDelayMs = intEnv(process.env, "RISK_CLAIM_REDEEM_DELAY_S", 30, 0) * 1000 + Number(this.staggerSeconds) * 1000;
    this.spotTakeoverMs = intEnv(process.env, "RISK_SPOT_TAKEOVER_S", 120, 0) * 1000 + Number(this.staggerSeconds) * 1000;
    this.migrateBudget = intEnv(process.env, "RISK_MIGRATE_PER_TICK", 4, 0);
    this.spot = new SpotExecutor(ctx, ring, id === "A" ? 1 : 2, id === "A" ? 2 : 3, sender, provers);
  }

  private scan(): void {
    const { ledger, chain } = this.ctx;
    if (ledger.generation !== this.generation) {
      this.generation = ledger.generation;
      this.scanned = 0;
      this.pairs = [];
      this.claims = [];
      this.locks = [];
      this.unreadableBlocks = [];
      this.deltaCache.clear();
    }
    for (; this.scanned < ledger.records.length; this.scanned++) {
      const r = ledger.records[this.scanned]!;
      if (r.kind === RECORD_LOCK) {
        let l = this.lockCache.get(r.commitment);
        if (l === undefined) {
          l = this.ring.open((sk) => openLock(r.ciphertext.slice(this.lockSlot * LOCK_CT_LEN, (this.lockSlot + 1) * LOCK_CT_LEN), sk, chain.deploymentId, r.commitment));
          this.lockCache.set(r.commitment, l);
        }
        if (l) this.locks.push({ record: l.value, leafIndex: r.leafIndex, keyIndex: l.keyIndex });
        else this.unreadableBlocks.push(r.block);
      } else if (r.kind === RECORD_PAIR) {
        let p = this.pairCache.get(r.commitment);
        if (p === undefined) {
          p = this.ring.open((sk) => openPair(r.ciphertext.slice(this.slotPair * PAIR_CT_LEN, (this.slotPair + 1) * PAIR_CT_LEN), sk, chain.deploymentId, r.commitment));
          this.pairCache.set(r.commitment, p);
        }
        if (p) this.pairs.push({ record: p.value, leafIndex: r.leafIndex, keyIndex: p.keyIndex });
        else this.unreadableBlocks.push(r.block);
      } else if (r.kind === RECORD_CLAIM) {
        let c = this.claimCache.get(r.commitment);
        if (c === undefined) {
          c = this.ring.open((sk) => openClaim(r.ciphertext.slice(this.slotClaim * CLAIM_CT_LEN, (this.slotClaim + 1) * CLAIM_CT_LEN), sk, chain.deploymentId, r.commitment));
          this.claimCache.set(r.commitment, c);
        }
        if (c) this.claims.push({ record: c.value, leafIndex: r.leafIndex, keyIndex: c.keyIndex });
        else this.unreadableBlocks.push(r.block);
      }
    }
  }

  private livePairs(): HeldPair[] {
    const { ledger, chain } = this.ctx;
    const out: HeldPair[] = [];
    for (const { record, leafIndex, keyIndex } of this.pairs) {
      const nullifier = recNullifier(pairCommitment(chain.deploymentId, record), record.recNonce);
      if (!ledger.isSpent(nullifier) && leafIndex < ledger.processed) out.push({ pair: record, leafIndex, nullifier, keyIndex });
    }
    return out;
  }

  /** Null when no held key opens the latest record; the caller skips that market rather than proving from garbage. */
  private marketState(market: bigint): MarketState | null {
    const last = this.ctx.ledger.latestFunding(market);
    if (!last) return { longOi: 0n, shortOi: 0n, insurance: 0n, badDebt: 0n, bondUsed: 0n, blind: 0n };
    return this.openedMarket(market, last)?.value ?? null;
  }

  private openedMarket(market: bigint, last: { head: bigint; ciphertext: readonly bigint[] }): RingHit<MarketState> | null {
    let hit = this.marketStates.get(last.head);
    if (!hit) {
      const opened = openMarketState(this.ring, last.ciphertext.slice(this.slotMarket * MARKET_CT_LEN, (this.slotMarket + 1) * MARKET_CT_LEN), this.ctx.chain.deploymentId, market, last.head);
      if (!opened) return null;
      hit = opened;
      this.marketStates.set(last.head, hit);
    }
    return hit;
  }

  private currentKeyIndex(): number {
    return this.ring.indexOf(this.ctx.chain.riskKeys[this.riskSlot]);
  }

  /**
   * Reports what still depends on a retired key. When `retiredKeyRecords` reaches zero on both workers, that key can be retired
   * for good. It counts unspent pairs, claims and locks wherever they sit in the queue, and unfolded OI deltas that can only be
   * opened from a retired-key record (a spent pair's open, close or liquidation delta). Records no key opens count only from
   * the current key's activation on, since older ones go dark by design once a retired key is destroyed.
   */
  private keyHealth(): { keysHeld: number; currentKeyHeld: boolean; retiredKeyRecords: number; unreadableRecords: number } {
    const { chain, ledger } = this.ctx;
    const current = this.currentKeyIndex();
    const slotKey = chain.riskKeys[this.riskSlot];
    const since = currentKeySince(chain.genesisKeys, ledger.keyRotations, this.riskSlot === 0 ? "riskA" : "riskB", slotKey);
    let retired = retiredUnspent(this.pairs, current, (p) => ledger.isSpent(recNullifier(pairCommitment(chain.deploymentId, p.record), p.record.recNonce)));
    retired += retiredUnspent(this.claims.filter((c) => c.record.amount !== 0n), current, (c) => ledger.isSpent(recNullifier(claimCommitment(chain.deploymentId, c.record), c.record.recNonce)));
    retired += retiredUnspent(this.locks, current, (l) => ledger.isSpent(recNullifier(lockCommitment(chain.deploymentId, l.record), l.record.recNonce)));
    const pending = [...this.pendingDeltas.values()].flat();
    if (pending.length > 0) retired += retiredDeltas(pending, this.deltaOpenings(), current);
    let unreadableMarkets = 0;
    for (const m of chain.markets) {
      const last = ledger.latestFunding(m.id);
      if (!last) continue;
      const hit = this.openedMarket(m.id, last);
      if (!hit) unreadableMarkets++;
      else if (hit.keyIndex !== current) retired++;
    }
    const spot = chain.spot ? this.spot.retiredKeyRecords(current, since) : { retired: 0, unreadable: 0 };
    return {
      keysHeld: this.ring.keys.length, currentKeyHeld: current !== -1, retiredKeyRecords: retired + spot.retired,
      unreadableRecords: countAfter(this.unreadableBlocks, since) + unreadableMarkets + spot.unreadable,
    };
  }

  /** Delta commitments at indices [from, to) of a market's OI queue, reading only the ones not seen before. */
  private async deltaCommitments(market: bigint, from: bigint, to: bigint): Promise<bigint[]> {
    const out: bigint[] = [];
    for (let i = from; i < to; i++) {
      const key = `${market}:${i}`;
      let commitment = this.deltaCache.get(key);
      if (commitment === undefined) {
        commitment = await this.ctx.chain.oiDelta(market, i);
        this.deltaCache.set(key, commitment);
      }
      out.push(commitment);
    }
    return out;
  }

  /** Counts a race lost as such and everything else by its name, so a health check shows real failures only. */
  private tally(what: string, outcome: TxOutcome): "landed" | "lost" | "retry" | "failed" {
    if (outcome.status === "confirmed") {
      this.ctx.bump(what);
      this.ctx.recordAction(what, outcome.hash);
      return "landed";
    }
    if (outcome.status === "timeout") return "retry";
    if (RACE_REASONS.has(outcome.revert.reason)) {
      this.ctx.bump("lostRaces");
      this.ctx.log.info("race_lost", { action: what, status: outcome.status });
      return "lost";
    }
    if (FROZEN_REASONS.has(outcome.revert.reason)) {
      this.ctx.bump("frozenLineages");
      this.ctx.log.info("lineage_frozen", { action: what, reason: outcome.revert.reason });
      return "lost";
    }
    if (RETRY_REASONS.has(outcome.revert.reason)) {
      this.ctx.bump("reproved");
      this.ctx.log.info("action_retry", { action: what, reason: outcome.revert.reason });
      return "retry";
    }
    this.ctx.log.warn("action_failed", { action: what, reason: outcome.revert.reason });
    return "failed";
  }

  /** True once this worker's stagger has passed since the market's queue filled a batch at this fold count. */
  private fullBatchStaggered(market: bigint, consumed: bigint): boolean {
    let since = this.batchFullSince.get(market);
    if (since?.consumed !== consumed) {
      since = { consumed, at: Date.now() };
      this.batchFullSince.set(market, since);
    }
    return Date.now() - since.at >= Number(this.staggerSeconds) * 1000;
  }

  private due(key: string): boolean {
    return (this.backoff.get(key) ?? 0) <= Date.now();
  }

  private delay(key: string, ms: number): void {
    this.backoff.set(key, Date.now() + ms);
  }

  private async liquidate(m: MarketInfo, h: HeldPair, mark: bigint, fundingIndex: bigint): Promise<void> {
    const { chain, ledger, log } = this.ctx;
    const witness = liquidateWitness({
      pair: h.pair, leafIndex: h.leafIndex, deployment: chain.deploymentId, tree: ledger.tree, mark, mmrWad: m.mmrWad, penaltyBps: m.penaltyBps, scale: m.scale, riskKeys: chain.riskKeys, fundingIndex, liquidator: this.rewardTo,
    });
    const started = performance.now();
    let proof;
    try {
      proof = await (await this.provers.get("liquidate")).prove(witness.inputs);
    } catch (error) {
      log.warn("liquidate_proof_refused", { market: m.id, message: errorMessage(error) });
      this.delay(`liq:${h.nullifier}`, 10_000);
      return;
    }
    const outcome = await this.sender.send("liquidate", [bytesToHex(proof.proof), { ...witness.publicInputs }]);
    const result = this.tally("liquidations", outcome);
    log.info("liquidation_attempt", { market: m.id, result, proveMs: Math.round(performance.now() - started), tx: "hash" in outcome ? outcome.hash : null });
    if (result === "failed") this.delay(`liq:${h.nullifier}`, 10_000);
  }

  private async closeMatured(m: MarketInfo, h: HeldPair, mode: bigint, mark: bigint, fundingIndex: bigint): Promise<void> {
    const { chain, ledger, log } = this.ctx;
    const witness = closeWitness({ pair: h.pair, leafIndex: h.leafIndex, deployment: chain.deploymentId, tree: ledger.tree, mode, mark, scale: m.scale, fundingIndex, sk: 0n, feeBps: m.takerFeeBps, feeTo: chain.feeTo });
    let proof;
    try {
      proof = await (await this.provers.get("close_pair")).prove(witness.inputs);
    } catch (error) {
      log.warn("close_proof_refused", { market: m.id, message: errorMessage(error) });
      this.delay(`close:${h.nullifier}`, 30_000);
      return;
    }
    const outcome = await this.sender.send("closePair", [bytesToHex(proof.proof), { ...witness.publicInputs }]);
    this.tally("forcedCloses", outcome);
  }

  /** Nearly all epoch races end when the head moves under a proof; that is a lost race, not a broken proof. */
  private async advanceFunding(m: MarketInfo, price: PriceRead): Promise<void> {
    const { chain, log } = this.ctx;
    const [funding, now, count] = await Promise.all([chain.funding(m.id), chain.blockTime(), chain.oiDeltaCount(m.id)]);
    if (now <= funding.lastEpoch) return;
    const deltas: { opening: OiDelta; commitment: bigint }[] = [];
    if (count > funding.consumed) {
      const openings = this.deltaOpenings();
      const end = count < funding.consumed + BigInt(OI_BATCH) ? count : funding.consumed + BigInt(OI_BATCH);
      const commitments = await this.deltaCommitments(m.id, funding.consumed, end);
      for (const [offset, commitment] of commitments.entries()) {
        const source = openings.get(commitment);
        if (!source) {
          log.warn("delta_unopenable", { market: m.id, index: funding.consumed + BigInt(offset) });
          this.ctx.liveness.blocked = "DELTA_UNOPENABLE";
          return;
        }
        deltas.push({ opening: source.opening, commitment });
      }
    }
    const state = this.marketState(m.id);
    if (!state) {
      log.warn("market_state_unreadable", { market: m.id });
      this.delay(`epoch:${m.id}`, 60_000);
      return;
    }
    // The circuit binds the head's private bond draw to the public one the contract stores; a mismatch can't prove.
    if (state.bondUsed !== funding.bondUsed) {
      log.warn("bond_used_mismatch", { market: m.id });
      this.delay(`epoch:${m.id}`, 60_000);
      return;
    }
    const fresh = price.fresh;
    const elapsed = now - funding.lastEpoch;
    const dt = fresh ? (elapsed > 3600n ? 3600n : elapsed) : 0n;
    const witness = fundingEpochWitness({ deployment: chain.deploymentId, market: m.id, state, head: funding.head, deltas, asOf: now, dt, mark: fresh ? price.price : 0n, maxRateWad: m.maxFundingPerHourWad, keys: [chain.coordinator, chain.riskKeys[0], chain.riskKeys[1]], bondTotal: await chain.read<bigint>("marketBond", [m.id]) });
    let proof;
    try {
      proof = await (await this.provers.get("funding_epoch")).prove(witness.inputs);
    } catch (error) {
      log.warn("epoch_proof_refused", { market: m.id, message: errorMessage(error) });
      this.delay(`epoch:${m.id}`, 15_000);
      return;
    }
    const outcome = await this.sender.send("advanceFunding", [bytesToHex(proof.proof), { ...witness.publicInputs }]);
    if (outcome.status !== "confirmed" && outcome.status !== "timeout" && outcome.revert.reason === "INVALID_PROOF" && (await chain.funding(m.id)).head !== funding.head) {
      this.ctx.bump("lostRaces");
      log.info("race_lost", { action: "advanceFunding", market: m.id });
      return;
    }
    this.tally("epochs", outcome);
  }

  /**
   * Every pending change is the open, full close or partial reduce of a pair this key can read (test: pendingDeltas). Each
   * opening carries the ring keys of the records it was built from, so key health can tell which still need a retired key.
   */
  private deltaOpenings(): Map<bigint, DeltaSource<OiDelta>> {
    const { chain } = this.ctx;
    const openings = new Map<bigint, DeltaSource<OiDelta>>();
    const byNonce = new Map(this.pairs.map((p) => [p.record.recNonce, p]));
    for (const { record: c, keyIndex } of this.claims) {
      const parent = byNonce.get(c.pairNonce);
      if (parent) {
        openings.set(c.deltaCm, {
          opening: { isShort: parent.record.isShort, size: parent.record.size, kind: OI_CLOSE, recNonce: c.pairNonce, insIn: c.insIn, claim: c.amount },
          keyIndices: [keyIndex, parent.keyIndex],
        });
      }
    }
    for (const { record: p, keyIndex } of this.pairs) {
      for (const [size, kind] of [[p.size, OI_OPEN], [p.size, OI_CLOSE], [p.lastReduce, OI_REDUCE]] as const) {
        openings.set(oiDeltaCommitment(chain.deploymentId, p.market, p.isShort, size, kind, p.recNonce), { opening: { isShort: p.isShort, size, kind, recNonce: p.recNonce }, keyIndices: [keyIndex] });
      }
    }
    return openings;
  }

  /**
   * A keyless update: funding settlement, or a key migration that changes nothing else. `asOf` is the latest block time, which
   * the contract accepts for two minutes; the cooldown and health rules are checked against it before proving.
   */
  private async settleFunding(m: MarketInfo, h: HeldPair, mark: bigint, fundingIndex: bigint, asOf: bigint, counter = "fundingSettlements"): Promise<void> {
    const { chain, ledger, log } = this.ctx;
    const noteOwner = deriveKeys(randomField());
    const witness = updateWitness({
      pair: h.pair, leafIndex: h.leafIndex, deployment: chain.deploymentId, tree: ledger.tree, update: KEYLESS_UPDATE, sk: 0n, noteOwner,
      mark, imrWad: m.imrWad, mmrWad: m.mmrWad, scale: m.scale, feeBps: m.takerFeeBps, fundingIndex, riskKeys: chain.riskKeys, feeTo: chain.feeTo, asOf, minGap: this.minGap,
      carryExit: ledger.exitFor(h.nullifier) !== undefined,
    });
    if (witness.outcome.refused !== null) {
      log.info("settle_skipped", { market: m.id, reason: witness.outcome.refused });
      this.delay(`settle:${h.nullifier}`, 30_000);
      return;
    }
    let proof;
    try {
      proof = await (await this.provers.get("pair_update")).prove(witness.inputs);
    } catch (error) {
      log.warn("settle_proof_refused", { market: m.id, message: errorMessage(error) });
      this.delay(`settle:${h.nullifier}`, 30_000);
      return;
    }
    const outcome = await this.sender.send("updatePair", [bytesToHex(proof.proof), { ...witness.publicInputs }]);
    log.info("keyless_update", { action: counter, market: m.id, result: this.tally(counter, outcome) });
  }

  /**
   * Whether a keyless update can run now: outside the pair's cooldown, before any exit on it matures (the contract freezes the
   * lineage then, so the forced close always lands), and leaving the pair healthy (a pair that would be liquidatable is left
   * to liquidation).
   */
  private keylessUpdateAllowed(m: MarketInfo, h: HeldPair, mark: bigint, fundingIndex: bigint, asOf: bigint): boolean {
    if (asOf < nextUpdateAt(h.pair, this.minGap)) return false;
    const exit = this.ctx.ledger.exitFor(h.nullifier);
    if (exit && asOf >= exit.matureAt) return false;
    return updateOutcome(h.pair, KEYLESS_UPDATE, mark, m.imrWad, m.scale, fundingIndex, m.takerFeeBps, { mmrWad: m.mmrWad, asOf, minGap: this.minGap }).refused === null;
  }

  /** Whether accrued funding is worth a settlement, relative to the payer's margin. */
  private settleDue(m: MarketInfo, h: HeldPair, mark: bigint, fundingIndex: bigint, asOf: bigint): boolean {
    const p = h.pair;
    if (p.fundingIndex === fundingIndex || !this.keylessUpdateAllowed(m, h, mark, fundingIndex, asOf)) return false;
    const o = updateOutcome(p, KEYLESS_UPDATE, mark, m.imrWad, m.scale, fundingIndex, m.takerFeeBps, { mmrWad: m.mmrWad, asOf, minGap: this.minGap });
    if (o.refused !== null || o.fundingOwed === 0n) return false;
    const payer = liquidationOutcome(p, mark, m.mmrWad, m.penaltyBps, m.scale, fundingIndex).takerPaysFunding ? p.takerMargin : p.makerMargin;
    return o.fundingOwed * BPS >= payer * this.settleMinBps;
  }

  async tick(): Promise<void> {
    const { chain, ledger, liveness } = this.ctx;
    this.scan();
    const now = await chain.blockTime();
    const live = this.livePairs();
    const prices = new Map<bigint, PriceRead>();
    const funding = new Map<bigint, Awaited<ReturnType<typeof chain.funding>>>();
    for (const m of chain.markets) {
      prices.set(m.id, await chain.price(m));
      funding.set(m.id, await chain.funding(m.id));
    }
    const backlog = { unhealthy: 0, epochsDue: 0, foldsPending: 0, settlementsDue: 0, exitsMatured: 0, queueBehind: ledger.queueLength - ledger.processed };

    // Liquidations first: every other job can wait a block, these cannot.
    for (const h of live) {
      const m = chain.market(h.pair.market);
      const price = prices.get(h.pair.market);
      const state = funding.get(h.pair.market);
      if (!m || !state) continue;
      if (!price?.fresh) continue;
      const o = liquidationOutcome(h.pair, price.price, m.mmrWad, m.penaltyBps, m.scale, state.index);
      if (!o.takerBad && !o.makerBad) continue;
      backlog.unhealthy++;
      if (this.due(`liq:${h.nullifier}`)) await this.liquidate(m, h, price.price, state.index);
    }
    if (backlog.unhealthy > 0) await ledger.sync();
    this.scan();

    // Funding epochs and folds: fold what is queued soon, otherwise keep the clock inside the one-hour staleness limit.
    for (const m of chain.markets) {
      const st = funding.get(m.id);
      const price = prices.get(m.id);
      if (!st || !price) continue;
      const count = await chain.oiDeltaCount(m.id);
      const pending = count - st.consumed;
      this.pendingDeltas.set(m.id, await this.deltaCommitments(m.id, st.consumed, count));
      const age = now - st.lastEpoch;
      backlog.foldsPending += Number(pending);
      // A full batch folds without waiting out the gap (#17), so churn can't build a backlog. The stagger still applies, so
      // both workers don't prove the same epoch at once.
      const full = pending >= BigInt(OI_BATCH);
      if (!full) this.batchFullSince.delete(m.id);
      const due = full
        ? this.fullBatchStaggered(m.id, st.consumed)
        : pending > 0n ? age >= this.foldGapSeconds + this.staggerSeconds : age >= this.epochIntervalSeconds + this.staggerSeconds;
      if (!due) continue;
      backlog.epochsDue++;
      if (this.due(`epoch:${m.id}`)) await this.advanceFunding(m, price);
    }

    // Matured forced exits close at the mark (or, with a dead oracle, at entry) with no owner online.
    for (const h of this.livePairs()) {
      const exit = ledger.exitFor(h.nullifier);
      if (!exit || now < exit.matureAt) continue;
      const m = chain.market(h.pair.market);
      const price = prices.get(h.pair.market);
      const state = await chain.funding(h.pair.market);
      if (!m || !price) continue;
      const lastSeen = (await chain.read<bigint>("lastFreshPrice", [m.id]));
      const dead = !price.fresh && now - (price.updatedAt > lastSeen ? price.updatedAt : lastSeen) >= ORACLE_DEAD_AFTER;
      if (!price.fresh && !dead) continue;
      backlog.exitsMatured++;
      if (this.due(`close:${h.nullifier}`)) await this.closeMatured(m, h, price.fresh ? CLOSE_MATURED : CLOSE_DEAD_ORACLE, price.fresh ? price.price : 0n, state.index);
    }

    // Moving positions off a retired key goes first: the same keyless update also settles funding, so a settlement here would
    // migrate the pair anyway and leave no record that it was a migration.
    if ((await this.migratePairs(prices, now)) > 0) await ledger.sync();

    // Funding settlement with no owner key. A pending exit moves to the pair's next version with its deadline.
    for (const h of this.livePairs()) {
      const m = chain.market(h.pair.market);
      const price = prices.get(h.pair.market);
      const state = await chain.funding(h.pair.market);
      if (!m || !price) continue;
      const mark = price.fresh ? price.price : 0n;
      if (mark === 0n || !this.settleDue(m, h, mark, state.index, now)) continue;
      backlog.settlementsDue++;
      const since = this.settleDueSince.get(h.nullifier) ?? Date.now();
      this.settleDueSince.set(h.nullifier, since);
      if (Date.now() - since < Number(this.staggerSeconds) * 1000 || !this.due(`settle:${h.nullifier}`)) continue;
      await this.settleFunding(m, h, mark, state.index, await chain.blockTime());
    }

    await this.fallbackQueue();
    await this.redeemClaims();
    await this.sweepInsurance(now, prices);
    await this.releaseBonds();
    if (chain.spot) await this.spotTakeover(now);

    liveness.backlog = { ...backlog, spotPending: this.spot.pending };
    const keys = this.keyHealth();
    const blockers = [
      ...([...prices.values()].some((p) => !p.fresh) ? ["ORACLE_UNAVAILABLE_SOME_MARKETS"] : []),
      ...(!keys.currentKeyHeld || keys.unreadableRecords > 0 ? ["KEY_MISSING"] : []),
    ];
    liveness.blocked = blockers.length === 0 ? null : blockers.join(",");
    liveness.details = {
      keys,
      worker: this.slotPair === 2 ? "A" : "B", pairsTracked: this.pairs.length, pairsLive: this.livePairs().length, claimsTracked: this.claims.length,
      fundingAgeSeconds: Object.fromEntries(chain.markets.map((m) => [m.id.toString(), now - (funding.get(m.id)?.lastEpoch ?? now)])),
    };
  }

  /**
   * Moves positions still encrypted to a retired key onto the current keys with the same keyless update funding settlement uses. It changes
   * no margin or size and pays nothing to the worker, so it is safe to run without any owner online. Liquidatable pairs are left to liquidation.
   */
  private async migratePairs(prices: ReadonlyMap<bigint, PriceRead>, now: bigint): Promise<number> {
    const { chain } = this.ctx;
    const current = this.currentKeyIndex();
    if (current === -1) return 0;
    let budget = this.migrateBudget;
    for (const h of this.livePairs()) {
      if (budget === 0) break;
      if (h.keyIndex === current) continue;
      const m = chain.market(h.pair.market);
      const price = prices.get(h.pair.market);
      if (!m || !price?.fresh) continue;
      const state = await chain.funding(h.pair.market);
      // The cooldown (10 min after the pair's last version) and a matured exit both wait here rather than burn a proof.
      if (!this.keylessUpdateAllowed(m, h, price.price, state.index, now)) continue;
      const key = `migrate:${h.nullifier}`;
      const since = this.settleDueSince.get(h.nullifier) ?? Date.now();
      this.settleDueSince.set(h.nullifier, since);
      if (Date.now() - since < Number(this.staggerSeconds) * 1000 || !this.due(key)) continue;
      budget--;
      await this.settleFunding(m, h, price.price, state.index, await chain.blockTime(), "keyMigrations");
      this.delay(key, 30_000);
    }
    return this.migrateBudget - budget;
  }

  /** Owners of a folded claim get paid with no action; the note can only go to the claim's committed owner. */
  private async redeemClaims(): Promise<void> {
    const { chain, ledger, log } = this.ctx;
    for (const { record: c, leafIndex } of this.claims) {
      if (c.amount === 0n || leafIndex >= ledger.processed) continue;
      const nullifier = recNullifier(claimCommitment(chain.deploymentId, c), c.recNonce);
      if (ledger.isSpent(nullifier)) continue;
      const ratioPlusOne = await chain.read<bigint>("foldedRatioPlusOne", [toHex32(c.deltaCm)]);
      if (ratioPlusOne === 0n) continue;
      const ratio = ratioPlusOne - 1n;
      if ((c.amount * ratio) / 10n ** 18n === 0n) continue;
      const since = this.claimDueSince.get(nullifier) ?? Date.now();
      this.claimDueSince.set(nullifier, since);
      if (Date.now() - since < this.claimRedeemDelayMs) continue;
      const witness = redeemWitness({ claim: c, leafIndex, deployment: chain.deploymentId, tree: ledger.tree, ratio });
      let proof;
      try {
        proof = await (await this.provers.get("redeem_claim")).prove(witness.inputs);
      } catch (error) {
        log.warn("redeem_proof_refused", { message: errorMessage(error) });
        this.delay(`claim:${nullifier}`, 30_000);
        continue;
      }
      this.tally("claimsRedeemed", await this.sender.send("redeemClaim", [bytesToHex(proof.proof), { ...witness.publicInputs }]));
      await ledger.sync();
    }
  }

  /** D-17: a market with a long-dead oracle, nothing pending and no positions releases its insurance to the fee address. */
  private async sweepInsurance(now: bigint, prices: ReadonlyMap<bigint, PriceRead>): Promise<void> {
    const { chain, log } = this.ctx;
    for (const m of chain.markets) {
      const price = prices.get(m.id);
      if (!price || price.fresh || !this.due(`sweep:${m.id}`)) continue;
      const [st, count, lastFresh] = await Promise.all([chain.funding(m.id), chain.oiDeltaCount(m.id), chain.read<bigint>("lastFreshPrice", [m.id])]);
      const lastSeen = price.updatedAt > lastFresh ? price.updatedAt : lastFresh;
      if (now - lastSeen < INSURANCE_SWEEP_AFTER || count !== st.consumed || st.head === 0n) continue;
      const state = this.marketState(m.id);
      if (!state || state.longOi !== 0n || state.shortOi !== 0n || state.insurance === 0n) continue;
      const witness = insuranceSweepWitness({ deployment: chain.deploymentId, market: m.id, asset: BigInt(m.asset), state, head: st.head, feeTo: chain.feeTo, keys: [chain.coordinator, chain.riskKeys[0], chain.riskKeys[1]] });
      let proof;
      try {
        proof = await (await this.provers.get("insurance_sweep")).prove(witness.inputs);
      } catch (error) {
        log.warn("sweep_proof_refused", { market: m.id, message: errorMessage(error) });
        this.delay(`sweep:${m.id}`, 60_000);
        continue;
      }
      this.tally("insuranceSweeps", await this.sender.send("sweepInsurance", [bytesToHex(proof.proof), { ...witness.publicInputs }]));
      this.delay(`sweep:${m.id}`, 30_000);
    }
  }

  /** A market its creator has closed, once empty, returns the unused bond. The money can only reach the creator. */
  private async releaseBonds(): Promise<void> {
    const { chain, log } = this.ctx;
    for (const m of chain.markets) {
      if (m.id < 100n || !this.due(`bond:${m.id}`)) continue;
      const [policy, st, count] = await Promise.all([chain.marketPolicy(m.id), chain.funding(m.id), chain.oiDeltaCount(m.id)]);
      if (!policy.closeOnly || count !== st.consumed || st.head === 0n || (await chain.bondReleased(m.id))) continue;
      const state = this.marketState(m.id);
      if (!state || state.longOi !== 0n || state.shortOi !== 0n) continue;
      const witness = bondReleaseWitness({ deployment: chain.deploymentId, market: m.id, state, head: st.head });
      let proof;
      try {
        proof = await (await this.provers.get("bond_release")).prove(witness.inputs);
      } catch (error) {
        log.warn("bond_release_proof_refused", { market: m.id, message: errorMessage(error) });
        this.delay(`bond:${m.id}`, 60_000);
        continue;
      }
      const outcome = await this.sender.send("releaseBond", [bytesToHex(proof.proof), m.id, witness.bondUsed]);
      if (outcome.status !== "confirmed" && outcome.status !== "timeout" && outcome.revert.reason === "BOND_ALREADY_RELEASED") {
        this.ctx.bump("lostRaces");
        continue;
      }
      this.tally("bondReleases", outcome);
      this.delay(`bond:${m.id}`, 15_000);
    }
  }

  /**
   * With the coordinator gone a worker still reads every intent and LP record with its own key, so anything left waiting past
   * the takeover delay is executed here, in the same tree order, and expired locks are returned to their owners.
   */
  private async spotTakeover(now: bigint): Promise<void> {
    this.spot.scanLps();
    const { ledger, chain } = this.ctx;
    const due = (map: Map<number, number>, key: number): boolean => {
      const since = map.get(key) ?? Date.now();
      map.set(key, since);
      return Date.now() - since >= this.spotTakeoverMs;
    };
    const lpDue = (held: LpHeld): boolean => {
      const since = this.lpDueSince.get(held.nullifier) ?? Date.now();
      this.lpDueSince.set(held.nullifier, since);
      return Date.now() - since >= this.spotTakeoverMs;
    };
    const { open, expired } = this.spot.removals(now);
    const waiting = this.locks.filter((h) => (h.record.role === ROLE_SWAP || h.record.role === ROLE_LP) && h.record.expiry > now && h.leafIndex < ledger.processed
      && !ledger.isSpent(recNullifier(lockCommitment(chain.deploymentId, h.record), h.record.recNonce)));
    await this.spot.execute(waiting.filter((h) => due(this.lockDueSince, h.leafIndex)), open.filter(lpDue), now);
    for (const held of expired) if (lpDue(held)) await this.spot.returnToIdle(held, now);
    await releaseExpiredLocks(this.ctx, this.sender, this.provers, this.locks, now, this.releaseDelaySeconds);
  }

  /** Liquidations stop if nothing inserts new leaves. When the queue service is absent, process the queue here too. */
  private async fallbackQueue(): Promise<void> {
    const { ledger } = this.ctx;
    if (ledger.queueLength <= ledger.processed) {
      this.queueBacklogSince = null;
      return;
    }
    this.queueBacklogSince ??= Date.now();
    if (Date.now() - this.queueBacklogSince < this.queueFallbackMs) return;
    await processQueueOnce(this.ctx, this.sender, this.provers);
    this.ctx.bump("queueFallbackBatches");
  }
}

function parseRewardAddress(raw: string): PrivateAddress {
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => !/^(0x[0-9a-fA-F]+|\d+)$/.test(p))) throw new Error("RISK_REWARD_ADDRESS must be auth,x,y");
  const [auth, x, y] = parts as [string, string, string];
  return { auth: BigInt(auth), pk: { x: BigInt(x), y: BigInt(y) } };
}

const id = process.env.RISK_ID;
if (id !== "A" && id !== "B") throw new Error("RISK_ID must be A or B");

await runService({
  name: `risk-${id.toLowerCase()}`,
  port: intEnv(process.env, "PORT", id === "A" ? PORTS.riskA : PORTS.riskB, 1),
  async init(ctx) {
    const ring = new KeyRing([takeScalar(process.env, "RISK_SK"), ...takeScalarList(process.env, "RISK_SK_PREVIOUS")]);
    await ctx.chain.assertKeyKnown(ring, id === "A" ? "riskA" : "riskB", "RISK_SK");
    const rewardRaw = process.env.RISK_REWARD_ADDRESS;
    const rewardTo = rewardRaw ? parseRewardAddress(rewardRaw) : addressOf(deriveKeys(takeScalar(process.env, "RISK_REWARD_SEED")));
    const sender = new Sender(ctx.chain, takePrivateKey(process.env, "RISK_TX_KEY"), ctx.log);
    const provers = new Provers(ctx.config.proverThreads);
    const minGap = await ctx.chain.read<bigint>("MIN_UPDATE_GAP");
    if (minGap !== MIN_UPDATE_GAP) ctx.log.warn("min_update_gap_differs", { chain: minGap, sdk: MIN_UPDATE_GAP });
    const worker = new RiskWorker(ctx, id, ring, rewardTo, sender, provers, minGap);
    const routes: Route[] = ctx.chain.spot ? [quoteRoute(worker.spot)] : [];
    return { routes, tick: () => worker.tick(), shutdown: () => provers.destroyAll() };
  },
});
