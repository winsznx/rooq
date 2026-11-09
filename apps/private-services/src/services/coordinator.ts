/**
 * Matches taker locks against maker locks within committed terms and proves open_pair. Deterministic policy (RFQ-02):
 * takers in chain order; for each, the tightest maker spread, then chain order. Everything it holds is rebuilt from the
 * chain and its own key on restart. It can only fill a lock inside the lock's terms, or let it expire.
 */
import {
  BPS, ceilDiv, fillPrice, KeyRing, LOCK_CT_LEN, lockCommitment, marginRequirement, MARKET_CT_COORDINATOR, MARKET_CT_LEN, notionalUp, openLock, openMarketState, openPairWitness, pairPnl, positionFee, RECORD_LOCK, recNullifier, ROLE_LP, ROLE_MAKER, ROLE_SWAP, ROLE_TAKER,
  type HeldLock, type LockRecord, type MarketState, type RingHit,
} from "@rooq/private-sdk";
import { bytesToHex, type ChainContext, type FundingState, type MarketInfo, type PriceRead } from "../lib/chain";
import { intEnv, PORTS, takePrivateKey, takeScalar, takeScalarList } from "../lib/config";
import { Provers } from "../lib/provers";
import { errorMessage } from "../lib/log";
import { Sender } from "../lib/sender";
import { runService, type ServiceContext } from "../lib/service";
import type { Reason } from "../lib/errors";
import { quoteRoute, releaseExpiredLocks, SpotExecutor } from "../lib/spot-exec";

const MARKET_FUNDING_MAX_AGE = 3_600n;
const AS_OF_MARGIN_SECONDS = 120n;
const AS_OF_MIN_MARGIN_SECONDS = 30n;
const MAX_REPROVE = 5;
const RETRYABLE: ReadonlySet<Reason> = new Set<Reason>(["UNKNOWN_ROOT", "INVALID_PROOF", "STALE_AS_OF", "RPC_UNAVAILABLE"]);

interface Live extends HeldLock {
  readonly nullifier: bigint;
}

type Planned = { kind: "ok"; makerMargin: bigint; asOf: bigint; fill: bigint } | { kind: "skip"; reason: string };

function belowMargin(margin: bigint, gains: boolean, pnl: { floor: bigint; ceil: bigint }, requirement: bigint): boolean {
  return gains ? margin + pnl.floor < requirement : margin < requirement + pnl.ceil;
}

class Coordinator {
  private readonly decoded = new Map<bigint, RingHit<LockRecord> | null>();
  private readonly marketStates = new Map<bigint, RingHit<MarketState>>();
  private unreadableLocks = 0;
  private generation = -1;
  private scanned = 0;
  private held: { record: LockRecord; leafIndex: number; commitment: bigint; keyIndex: number }[] = [];
  private blockedUntil = new Map<string, number>();
  private readonly marginBufferBps: bigint;
  private readonly releaseDelaySeconds: bigint;
  private readonly spot: SpotExecutor;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly ring: KeyRing,
    private readonly sender: Sender,
    private readonly provers: Provers,
  ) {
    this.spot = new SpotExecutor(ctx, ring, 0, 1, sender, provers);
    this.releaseDelaySeconds = BigInt(intEnv(process.env, "COORDINATOR_RELEASE_DELAY_S", 300, 0));
    this.marginBufferBps = BigInt(intEnv(process.env, "COORDINATOR_MAKER_MARGIN_BUFFER_BPS", 12_000, 10_000));
  }

  private scan(): void {
    const { ledger, chain } = this.ctx;
    if (ledger.generation !== this.generation) {
      this.generation = ledger.generation;
      this.scanned = 0;
      this.held = [];
      this.unreadableLocks = 0;
    }
    for (; this.scanned < ledger.records.length; this.scanned++) {
      const r = ledger.records[this.scanned]!;
      if (r.kind !== RECORD_LOCK) continue;
      let lock = this.decoded.get(r.commitment);
      if (lock === undefined) {
        lock = this.ring.open((sk) => openLock(r.ciphertext.slice(LOCK_CT_LEN, 2 * LOCK_CT_LEN), sk, chain.deploymentId, r.commitment));
        this.decoded.set(r.commitment, lock);
      }
      if (lock) this.held.push({ record: lock.value, leafIndex: r.leafIndex, commitment: r.commitment, keyIndex: lock.keyIndex });
      else this.unreadableLocks++;
    }
  }

  private live(now: bigint): { takers: Live[]; makers: Live[]; waiting: number } {
    const { ledger, chain } = this.ctx;
    const out: Live[] = [];
    let waiting = 0;
    for (const h of this.held) {
      if (h.record.expiry <= now) continue;
      const nullifier = recNullifier(lockCommitment(chain.deploymentId, h.record), h.record.recNonce);
      if (ledger.isSpent(nullifier)) continue;
      if (h.leafIndex >= ledger.processed) {
        waiting++;
        continue;
      }
      out.push({ record: h.record, leafIndex: h.leafIndex, nullifier });
    }
    const takers = out.filter((l) => l.record.role === ROLE_TAKER).sort((a, b) => a.leafIndex - b.leafIndex);
    const makers = out.filter((l) => l.record.role === ROLE_MAKER).sort((a, b) => {
      if (a.record.t2 !== b.record.t2) return a.record.t2 < b.record.t2 ? -1 : 1;
      return a.leafIndex - b.leafIndex;
    });
    return { takers, makers, waiting };
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
      const opened = openMarketState(this.ring, last.ciphertext.slice(MARKET_CT_COORDINATOR * MARKET_CT_LEN, (MARKET_CT_COORDINATOR + 1) * MARKET_CT_LEN), this.ctx.chain.deploymentId, market, last.head);
      if (!opened) return null;
      hit = opened;
      this.marketStates.set(last.head, hit);
    }
    return hit;
  }

  /** What still needs a retired key: live locks and market records, plus spot, so an operator knows when a key is safe to retire. */
  private keyHealth(now: bigint): Record<string, unknown> {
    const { chain, ledger } = this.ctx;
    const current = this.ring.indexOf(chain.coordinator);
    let retired = 0;
    for (const h of this.held) {
      if (h.keyIndex === current || h.record.expiry <= now) continue;
      if (!ledger.isSpent(recNullifier(lockCommitment(chain.deploymentId, h.record), h.record.recNonce))) retired++;
    }
    let unreadableMarkets = 0;
    for (const m of chain.markets) {
      const last = ledger.latestFunding(m.id);
      if (!last) continue;
      const hit = this.openedMarket(m.id, last);
      if (!hit) unreadableMarkets++;
      else if (hit.keyIndex !== current) retired++;
    }
    const spot = chain.spot ? this.spot.retiredKeyRecords(current) : { retired: 0, unreadable: 0 };
    return { keysHeld: this.ring.keys.length, currentKeyHeld: current !== -1, retiredKeyRecords: retired + spot.retired, unreadableRecords: this.unreadableLocks + unreadableMarkets + spot.unreadable };
  }

  /** Mirrors the open_pair constraints cheaply, so a proof is only attempted for a fill that can succeed. */
  private plan(m: MarketInfo, t: LockRecord, mk: LockRecord, mark: bigint, now: bigint, funding: FundingState, oiCount: bigint, state: MarketState): Planned {
    if (t.market !== mk.market || t.asset !== mk.asset) return { kind: "skip", reason: "MARKET_MISMATCH" };
    if (now - funding.lastEpoch > MARKET_FUNDING_MAX_AGE) return { kind: "skip", reason: "FUNDING_STALE" };
    const expiry = t.expiry < mk.expiry ? t.expiry : mk.expiry;
    if (expiry - now < AS_OF_MIN_MARGIN_SECONDS) return { kind: "skip", reason: "LOCK_NEAR_EXPIRY" };
    const asOf = now + AS_OF_MARGIN_SECONDS < expiry ? now + AS_OF_MARGIN_SECONDS : expiry;
    const fill = fillPrice(mark, t.t2, mk.t2);
    if (t.t2 === 0n ? t.t4 < fill : fill < t.t4) return { kind: "skip", reason: "PRICE_OUTSIDE_LIMIT" };
    if (mk.t3 < t.t3) return { kind: "skip", reason: "SIZE_ABOVE_MAKER_MAXIMUM" };
    if (m.maxPairSize < t.t3) return { kind: "skip", reason: "SIZE_ABOVE_MARKET_MAXIMUM" };
    const pending = (oiCount - funding.consumed) * m.maxPairSize;
    if (m.maxOiUsdWad < notionalUp(state.longOi + state.shortOi + pending + t.t3, mark)) return { kind: "skip", reason: "OPEN_INTEREST_LIMIT" };
    const fee = positionFee(t.t3, fill, m.takerFeeBps, m.scale);
    if (t.amount < fee) return { kind: "skip", reason: "LOCK_CANNOT_PAY_FEE" };
    const im = marginRequirement(t.t3, mark, m.imrWad, m.scale);
    const pnl = pairPnl(t.t2, t.t3, fill, mark, m.scale);
    if (belowMargin(t.amount - fee, pnl.takerGains, pnl, im)) return { kind: "skip", reason: "TAKER_BELOW_INITIAL_MARGIN" };
    const makerGains = !pnl.takerGains;
    const requirement = im + (makerGains ? 0n : pnl.ceil);
    const buffered = ceilDiv(im * this.marginBufferBps, BPS) + (makerGains ? 0n : pnl.ceil);
    const makerMargin = buffered <= mk.amount ? buffered : mk.amount;
    if (makerMargin < requirement) return { kind: "skip", reason: "MAKER_BELOW_INITIAL_MARGIN" };
    return { kind: "ok", makerMargin, asOf, fill };
  }

  get spotExecutor(): SpotExecutor {
    return this.spot;
  }

  private spotLocks(now: bigint): HeldLock[] {
    const { ledger, chain } = this.ctx;
    return this.held
      .filter((h) => (h.record.role === ROLE_SWAP || h.record.role === ROLE_LP) && h.record.expiry > now && !ledger.isSpent(recNullifier(lockCommitment(chain.deploymentId, h.record), h.record.recNonce)))
      .map((h) => ({ record: h.record, leafIndex: h.leafIndex }));
  }

  private async spotTick(now: bigint): Promise<void> {
    if (!this.ctx.chain.spot) return;
    this.spot.scanLps();
    const { open, expired } = this.spot.removals(now);
    await this.spot.execute(this.spotLocks(now), open, now);
    for (const held of expired) await this.spot.returnToIdle(held, now);
  }

  private retryAfter(key: string, ms: number): void {
    this.blockedUntil.set(key, Date.now() + ms);
  }

  /** Proves and submits, re-proving when the root, the price or the market head moved. */
  private async open(m: MarketInfo, taker: Live, maker: Live): Promise<{ matched: boolean; reason: string | null }> {
    const { chain, ledger, log } = this.ctx;
    for (let attempt = 1; attempt <= MAX_REPROVE; attempt++) {
      if (attempt > 1) {
        await ledger.sync();
        await chain.refreshKeys();
      }
      if (ledger.isSpent(taker.nullifier) || ledger.isSpent(maker.nullifier)) return { matched: false, reason: "LOCK_CONSUMED" };
      const [funding, price, oiCount, block] = await Promise.all([chain.funding(m.id), chain.price(m), chain.oiDeltaCount(m.id), chain.client.getBlock({ blockTag: "latest" })]);
      if (!price.fresh) return { matched: false, reason: "ORACLE_UNAVAILABLE" };
      if ((await chain.marketPolicy(m.id)).closeOnly) return { matched: false, reason: "MARKET_CLOSE_ONLY" };
      const state = this.marketState(m.id);
      if (!state) return { matched: false, reason: "MARKET_STATE_UNREADABLE" };
      const plan = this.plan(m, taker.record, maker.record, price.price, block.timestamp, funding, oiCount, state);
      if (plan.kind === "skip") return { matched: false, reason: plan.reason };
      const witness = openPairWitness({
        taker, maker, makerMargin: plan.makerMargin, deployment: chain.deploymentId, tree: ledger.tree, mark: price.price, asOf: plan.asOf, imrWad: m.imrWad, scale: m.scale, riskKeys: chain.riskKeys,
        fundingIndex: funding.index, limits: { feeBps: m.takerFeeBps, feeTo: chain.feeTo, head: funding.head, state, oiPending: (oiCount - funding.consumed) * m.maxPairSize, maxOiUsd: m.maxOiUsdWad, maxPairSize: m.maxPairSize },
      });
      let proof;
      try {
        proof = await (await this.provers.get("open_pair")).prove(witness.inputs);
      } catch (error) {
        log.warn("open_proof_refused", { market: m.id, message: errorMessage(error) });
        return { matched: false, reason: "PROOF_REFUSED" };
      }
      const outcome = await this.sender.send("openPair", [bytesToHex(proof.proof), { ...witness.publicInputs }]);
      if (outcome.status === "confirmed") {
        this.ctx.recordAction("openPair", outcome.hash);
        this.ctx.bump("matches");
        log.info("pair_opened", { market: m.id, tx: outcome.hash, attempt });
        return { matched: true, reason: null };
      }
      if (outcome.status === "timeout") return { matched: false, reason: "TX_TIMEOUT" };
      if (RETRYABLE.has(outcome.revert.reason)) {
        this.ctx.bump("reproved");
        log.info("open_reproving", { market: m.id, reason: outcome.revert.reason, status: outcome.status, attempt });
        continue;
      }
      if (outcome.revert.reason === "NULLIFIER_SPENT") {
        this.ctx.bump("lostRaces");
        return { matched: false, reason: "LOCK_CONSUMED" };
      }
      return { matched: false, reason: outcome.revert.reason };
    }
    return { matched: false, reason: "REPROVE_LIMIT" };
  }

  async tick(): Promise<void> {
    const { chain, liveness } = this.ctx;
    this.scan();
    const now = await chain.blockTime();
    const { takers, makers, waiting } = this.live(now);
    const skips: Record<string, number> = {};
    let matched = 0;
    const usedMakers = new Set<number>();
    const prices = new Map<bigint, PriceRead>();
    for (const m of chain.markets) prices.set(m.id, await chain.price(m));
    for (const taker of takers) {
      const m = chain.market(taker.record.market);
      if (!m) continue;
      const key = `${taker.leafIndex}`;
      if ((this.blockedUntil.get(key) ?? 0) > Date.now()) continue;
      let result: { matched: boolean; reason: string | null } = { matched: false, reason: "NO_MAKER" };
      for (const maker of makers) {
        if (usedMakers.has(maker.leafIndex) || maker.record.market !== taker.record.market || maker.record.asset !== taker.record.asset) continue;
        if ((await chain.marketPolicy(m.id)).closeOnly) {
          result = { matched: false, reason: "MARKET_CLOSE_ONLY" };
          break;
        }
        const funding = await chain.funding(m.id);
        const oiCount = await chain.oiDeltaCount(m.id);
        const price = prices.get(m.id);
        if (!price?.fresh) {
          result = { matched: false, reason: "ORACLE_UNAVAILABLE" };
          break;
        }
        const state = this.marketState(m.id);
        if (!state) {
          result = { matched: false, reason: "MARKET_STATE_UNREADABLE" };
          break;
        }
        const plan = this.plan(m, taker.record, maker.record, price.price, now, funding, oiCount, state);
        if (plan.kind === "skip") {
          result = { matched: false, reason: plan.reason };
          continue;
        }
        result = await this.open(m, taker, maker);
        if (result.matched) {
          usedMakers.add(maker.leafIndex);
          matched++;
          break;
        }
        if (result.reason === "PROOF_REFUSED") this.retryAfter(`${taker.leafIndex}`, 15_000);
      }
      if (!result.matched && result.reason) skips[result.reason] = (skips[result.reason] ?? 0) + 1;
    }
    const reasons = Object.keys(skips);
    const keys = this.keyHealth(now);
    if (keys.currentKeyHeld === false || Number(keys.unreadableRecords) > 0) reasons.push("KEY_MISSING");
    liveness.blocked = reasons.length === 0 ? null : reasons.join(",");
    liveness.backlog = { takersOpen: takers.length - matched, makersOpen: makers.length - usedMakers.size, locksAwaitingTree: waiting };
    liveness.details = { locksTracked: this.held.length, skips, marketsActive: chain.markets.length, lastBlockTime: now, keys };
    await this.spotTick(now);
    await releaseExpiredLocks(this.ctx, this.sender, this.provers, this.held.map((h) => ({ record: h.record, leafIndex: h.leafIndex })), now, this.releaseDelaySeconds);
    liveness.backlog = { ...liveness.backlog, spotPending: this.spot.pending };
  }
}

await runService({
  name: "coordinator",
  port: intEnv(process.env, "PORT", PORTS.coordinator, 1),
  async init(ctx) {
    const ring = new KeyRing([takeScalar(process.env, "COORDINATOR_SK"), ...takeScalarList(process.env, "COORDINATOR_SK_PREVIOUS")]);
    await ctx.chain.assertKeyKnown(ring, "coordinator", "COORDINATOR_SK");
    const sender = new Sender(ctx.chain, takePrivateKey(process.env, "COORDINATOR_TX_KEY"), ctx.log);
    const provers = new Provers(ctx.config.proverThreads);
    const coordinator = new Coordinator(ctx, ring, sender, provers);
    return {
      routes: ctx.chain.spot ? [quoteRoute(coordinator.spotExecutor)] : [],
      tick: () => coordinator.tick(),
      shutdown: () => provers.destroyAll(),
    };
  },
});

