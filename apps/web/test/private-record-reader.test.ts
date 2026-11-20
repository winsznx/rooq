import { depositOpening, deriveKeys, encrypt, initCrypto, noteCommitment, PAIR_CT_LEN, PAIR_CT_MAKER, PAIR_CT_TAKER, randomField } from "@rooq/private-sdk";
import { noteCommitmentV1, pairCommitmentV1, PAIR_PT_LEN_V1, type PairRecordV1 } from "@rooq/private-sdk/legacy/v1";
import { beforeAll, describe, expect, it } from "vitest";
import { readerFor, Scanner } from "../lib/private/scanner";

describe("record reader selection (M36 record version)", () => {
  it("reads the current deployment's v1 records through the frozen legacy module", () => {
    // #given the pinned record version 1 #then the scanner uses the v1 commitment
    expect([readerFor(1).legacy, readerFor(1).noteCommitment]).toEqual([true, noteCommitmentV1]);
  });

  it("reads a v2 deployment with the current SDK", () => {
    expect([readerFor(2).legacy, readerFor(2).noteCommitment]).toEqual([false, noteCommitment]);
  });

  it("finds no claims or LP positions on an old deployment, since the SDK has no v1 opener for them", () => {
    const v1 = readerFor(1);
    expect([v1.openClaim([], 0n, 0n, 0n), v1.openLp([], 0n, 0n, 0n)]).toEqual([null, null]);
  });
});

describe("legacy v1 pair reader (re-audit)", () => {
  beforeAll(async () => {
    await initCrypto();
  });

  it("slices v1 pair ciphertexts at the v1 width, so taker and maker both open their v1 positions", () => {
    // #given a v1 pair encrypted to the taker, maker and both risk keys, as the v1 circuits wrote it
    const taker = deriveKeys(11n);
    const maker = deriveKeys(22n);
    const p: PairRecordV1 = {
      market: 1n, asset: 5n, isShort: 0n, size: 10n ** 18n, entry: 250n * 10n ** 18n, fundingIndex: 0n, closeSpread: 10n, fundingDebt: 0n, debtByTaker: 0n, lastReduce: 0n,
      takerMargin: 1000n, makerMargin: 1000n, takerAuth: 1n, takerX: taker.pk.x, takerY: taker.pk.y, makerAuth: 2n, makerX: maker.pk.x, makerY: maker.pk.y, recNonce: 3n, blind: 4n,
    };
    const dep = 77n;
    const cm = pairCommitmentV1(dep, p);
    const pt = [p.market, p.asset, p.isShort, p.size, p.entry, p.fundingIndex, p.closeSpread, p.fundingDebt, p.debtByTaker, p.lastReduce, p.takerMargin, p.makerMargin, p.takerAuth, p.takerX, p.takerY, p.makerAuth, p.makerX, p.makerY, p.recNonce, p.blind];
    const ct = [taker.pk, maker.pk, deriveKeys(33n).pk, deriveKeys(44n).pk].flatMap((k) => encrypt(pt, k, randomField()));
    const v1 = readerFor(1);
    // #then the reader's width is the v1 one, and each side opens its own slot
    expect([v1.pairCtLen, readerFor(2).pairCtLen, ct.length]).toEqual([PAIR_PT_LEN_V1 + 2, PAIR_CT_LEN, 4 * (PAIR_PT_LEN_V1 + 2)]);
    const open = (slot: number, sk: bigint) => v1.openPair(ct.slice(slot * v1.pairCtLen, (slot + 1) * v1.pairCtLen), sk, dep, cm);
    expect([open(PAIR_CT_TAKER, taker.encSk)?.size, open(PAIR_CT_MAKER, maker.encSk)?.size, open(PAIR_CT_MAKER, maker.encSk)?.updatedAt]).toEqual([p.size, p.size, 0n]);
  });
});

describe("deposit openings by record version (re-audit)", () => {
  beforeAll(async () => {
    await initCrypto();
  });

  it("keeps v1 deposits where they were and binds v2 openings to the deployment", () => {
    // #given one seed read against a v1 and a v2 deployment
    const [seed, dep] = [5n, (46630n << 160n) | 0xabcn];
    // #then the v1 scanner and shield path use the pre-M36 opening, and v2 differs per deployment
    expect(new Scanner(seed, 1).depositOpening(2, dep)).toEqual(depositOpening(seed, 2));
    expect(new Scanner(seed, 2).depositOpening(2, dep)).toEqual(depositOpening(seed, 2, { version: 2, deployment: dep }));
    expect(new Scanner(seed, 2).depositOpening(2, dep)).not.toEqual(new Scanner(seed, 2).depositOpening(2, dep + 1n));
  });
});
