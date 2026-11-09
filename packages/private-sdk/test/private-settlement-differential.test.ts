import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Noir } from "@noir-lang/noir_js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  closeOutcome, closeWitness, deriveKeys, foldClaims, fundingEpochWitness, marketHead, oiDeltaCommitment, noteCommitment, noteInner, ownerNullifier, updateWitness, FUNDING_INDEX_ZERO, initCrypto, liquidateWitness, liquidationOutcome, MerkleTree, pairCommitment,
  type PairRecord, addressOf,
} from "../src";
import { circuit } from "./helpers";

/**
 * Vectors come from crates/risk-kernel/src/private_pair.rs, built on signed RiskMath helpers. The SDK and circuits use
 * direction-plus-magnitude arithmetic. Every case runs through all three.
 */
interface Base { fundingDebt: string; closeSpreadBps: string; entry: string; fundingIndex: string; fundingSnapshot: string; makerMargin: string; mark: string; scale: string; size: string; takerMargin: string; fundingOwed: string; fundingPaid: string; fundingNetted: string; fundingWrittenOff: string; takerOut: string; makerOut: string }
interface LiqCase extends Base { mmrWad: string; penaltyBps: string; takerBad: boolean; makerBad: boolean; reward: string; toInsurance: string; claim: string }
interface EpochCase { bondLeft: string; bondUsedAdded: string; insurance: string; inflow: string; claims: string[]; ratio: string; insuranceNext: string; badDebtAdded: string; payouts: string[] }
interface CloseCase extends Base { mode: string; fill: string; shortPaid: string; feeBps: string; fee: string }
interface UpdateCase extends Omit<Base, "takerOut" | "makerOut" | "fundingWrittenOff"> { actor: string; add: string; remove: string; reduce: string; noteValue: string; imrWad: string; feeBps: string; refused: string | null; nextTakerMargin: string; nextMakerMargin: string; nextSize: string; nextFundingDebt: string; fee: string }
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const { cases } = JSON.parse(readFileSync(`${ROOT}contracts/test/vectors/risk_vectors.json`, "utf8")) as { cases: { privateLiquidation: LiqCase[]; privateClose: CloseCase[]; privateUpdate: UpdateCase[]; privateEpochClaims: EpochCase[] } };

const DEPLOYMENT = (46630n << 160n) | 0x1234n;
const ASSET = 0x7e955252e15c84f5768b83c41a71f9eba181802fn;
let taker: ReturnType<typeof deriveKeys>;
let maker: ReturnType<typeof deriveKeys>;
let worker: ReturnType<typeof deriveKeys>;

beforeAll(async () => {
  await initCrypto();
  [taker, maker, worker] = [deriveKeys(11n), deriveKeys(22n), deriveKeys(33n)];
});

function toPair(c: Pick<Base, "size" | "entry" | "fundingSnapshot" | "closeSpreadBps" | "takerMargin" | "makerMargin" | "fundingDebt">): PairRecord {
  const size = BigInt(c.size);
  const debt = BigInt(c.fundingDebt);
  return {
    market: 7n, asset: ASSET, isShort: size < 0n ? 1n : 0n, size: size < 0n ? -size : size, entry: BigInt(c.entry),
    fundingIndex: FUNDING_INDEX_ZERO + BigInt(c.fundingSnapshot), closeSpread: BigInt(c.closeSpreadBps), fundingDebt: debt < 0n ? -debt : debt, debtByTaker: debt > 0n ? 1n : 0n, lastReduce: 0n, takerMargin: BigInt(c.takerMargin), makerMargin: BigInt(c.makerMargin),
    takerAuth: taker.auth, takerX: taker.pk.x, takerY: taker.pk.y, makerAuth: maker.auth, makerX: maker.pk.x, makerY: maker.pk.y, recNonce: 5n, blind: 6n,
  };
}

function treeWith(p: PairRecord): MerkleTree {
  const tree = new MerkleTree();
  tree.insert(pairCommitment(DEPLOYMENT, p));
  return tree;
}

describe("private settlement against the independent kernel", () => {
  it("liquidation: reference, SDK and circuit agree on all 300 cases", async () => {
    const noir = new Noir(circuit("liquidate"));
    let liquidated = 0;
    for (const c of cases.privateLiquidation) {
      const pair = toPair(c);
      const index = FUNDING_INDEX_ZERO + BigInt(c.fundingIndex);
      const [mark, mmr, bps, scale] = [BigInt(c.mark), BigInt(c.mmrWad), BigInt(c.penaltyBps), BigInt(c.scale)];
      const o = liquidationOutcome(pair, mark, mmr, bps, scale, index);
      expect([o.takerBad, o.makerBad]).toEqual([c.takerBad, c.makerBad]);
      expect([o.takerOut, o.makerOut, o.reward, o.toInsurance, o.claim, o.fundingOwed, o.fundingPaid, o.fundingNetted, o.fundingWrittenOff].map(String))
        .toEqual([c.takerOut, c.makerOut, c.reward, c.toInsurance, c.claim, c.fundingOwed, c.fundingPaid, c.fundingNetted, c.fundingWrittenOff]);

      const w = liquidateWitness({ pair, leafIndex: 0, deployment: DEPLOYMENT, tree: treeWith(pair), mark, mmrWad: mmr, penaltyBps: bps, scale, riskKeys: [maker.pk, worker.pk], fundingIndex: index, liquidator: addressOf(worker) });
      if (c.takerBad || c.makerBad) {
        liquidated++;
        await noir.execute(w.inputs);
      } else {
        await expect(noir.execute(w.inputs)).rejects.toThrow("pair is healthy");
      }
    }
    expect(liquidated).toBeGreaterThan(50);
  }, 280_000);

  it("epoch claims: reference, SDK and circuit agree on all 200 batches", async () => {
    const noir = new Noir(circuit("funding_epoch"));
    let short = 0;
    for (const c of cases.privateEpochClaims) {
      const claims = c.claims.map(BigInt);
      const [insurance, inflow] = [BigInt(c.insurance), BigInt(c.inflow)];
      const bondLeft = BigInt(c.bondLeft);
      const folded = foldClaims(insurance, inflow, claims, bondLeft);
      expect(String(folded.bondUsedAdded)).toBe(c.bondUsedAdded);
      expect([folded.ratio, folded.insuranceNext, folded.badDebtAdded].map(String)).toEqual([c.ratio, c.insuranceNext, c.badDebtAdded]);
      expect(folded.payouts.map(String)).toEqual(c.payouts);
      if (folded.ratio < 10n ** 18n) short++;
      const state = { longOi: 0n, shortOi: 0n, insurance, badDebt: 0n, bondUsed: 0n, blind: 77n };
      const deltas = claims.map((claim, i) => {
        const opening = { isShort: 0n, size: 0n, remove: 1n, recNonce: BigInt(i + 1), claim, insIn: i === 0 ? inflow : 0n };
        return { opening, commitment: oiDeltaCommitment(DEPLOYMENT, 7n, 0n, 0n, 1n, opening.recNonce, opening.insIn, claim) };
      });
      if (claims.length === 0 && inflow !== 0n) continue;
      const head = marketHead(DEPLOYMENT, 7n, state);
      const w = fundingEpochWitness({ deployment: DEPLOYMENT, market: 7n, state, head, deltas, asOf: 1n, dt: 0n, mark: 0n, maxRateWad: 0n, keys: [taker.pk, maker.pk, worker.pk], bondTotal: bondLeft });
      await noir.execute(w.inputs);
    }
    expect(short).toBeGreaterThan(10);
  }, 280_000);

  it("close: reference, SDK and circuit agree on all 300 cases across the three modes", async () => {
    const noir = new Noir(circuit("close_pair"));
    let refused = 0;
    for (const c of cases.privateClose) {
      const pair = toPair(c);
      const index = FUNDING_INDEX_ZERO + BigInt(c.fundingIndex);
      const [mode, mark, scale] = [BigInt(c.mode), BigInt(c.mark), BigInt(c.scale)];
      const feeBps = BigInt(c.feeBps);
      const o = closeOutcome(pair, mode, mark, scale, index, feeBps);
      expect([o.fill, o.takerOut, o.makerOut, o.fee, o.shortPaid, o.fundingOwed, o.fundingPaid, o.fundingNetted, o.fundingWrittenOff].map(String))
        .toEqual([c.fill, c.takerOut, c.makerOut, c.fee, c.shortPaid, c.fundingOwed, c.fundingPaid, c.fundingNetted, c.fundingWrittenOff]);

      const w = closeWitness({ pair, leafIndex: 0, deployment: DEPLOYMENT, tree: treeWith(pair), mode, mark, scale, fundingIndex: index, sk: taker.sk, feeBps, feeTo: addressOf(worker) });
      if (mode === 0n && o.shortPaid > 0n) {
        refused++;
        await expect(noir.execute(w.inputs)).rejects.toThrow("underwater pair cannot close");
      } else {
        await noir.execute(w.inputs);
      }
    }
    expect(refused).toBeGreaterThan(0);
  }, 280_000);

  it("update: reference, SDK and circuit agree on all 300 cases, including refusals", async () => {
    const noir = new Noir(circuit("pair_update"));
    const riskKeys = [maker.pk, worker.pk] as const;
    const reasons = new Map<string, number>();
    for (const c of cases.privateUpdate) {
      const pair = toPair(c);
      const index = FUNDING_INDEX_ZERO + BigInt(c.fundingIndex);
      const [mark, imr, scale, feeBps, actor] = [BigInt(c.mark), BigInt(c.imrWad), BigInt(c.scale), BigInt(c.feeBps), BigInt(c.actor)];
      const update = { actor, add: BigInt(c.add), remove: BigInt(c.remove), reduce: BigInt(c.reduce) };
      const tree = treeWith(pair);
      const value = BigInt(c.noteValue);
      const inner = noteInner(taker.owner, 91n, 92n);
      const commitment = noteCommitment(DEPLOYMENT, ASSET, value, inner);
      tree.insert(commitment);
      const note = value === 0n ? undefined : { leafIndex: 1, asset: ASSET, value, rho: 91n, blind: 92n, commitment, nullifier: ownerNullifier(taker.nk, commitment) };
      const w = updateWitness({
        pair, leafIndex: 0, deployment: DEPLOYMENT, tree, update, sk: actor === 2n ? maker.sk : taker.sk, noteOwner: taker, note,
        mark, imrWad: imr, scale, feeBps, fundingIndex: index, riskKeys, feeTo: addressOf(worker),
      });
      const o = w.outcome;
      expect(o.refused).toBe(c.refused);
      expect([o.size, o.fee, o.fundingOwed, o.fundingPaid, o.fundingNetted].map(String)).toEqual([c.nextSize, c.fee, c.fundingOwed, c.fundingPaid, c.fundingNetted]);
      const debt = BigInt(c.nextFundingDebt);
      expect(o.fundingDebt).toBe(debt < 0n ? -debt : debt);
      if (c.refused) {
        reasons.set(c.refused, (reasons.get(c.refused) ?? 0) + 1);
        await expect(noir.execute(w.inputs)).rejects.toThrow(c.refused);
      } else {
        expect([o.takerMargin, o.makerMargin].map(String)).toEqual([c.nextTakerMargin, c.nextMakerMargin]);
        await noir.execute(w.inputs);
      }
    }
    console.log("refusals exercised", Object.fromEntries(reasons));
    expect(reasons.size).toBeGreaterThanOrEqual(2);
  }, 280_000);
});
