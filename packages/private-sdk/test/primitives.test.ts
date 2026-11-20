import { beforeAll, describe, expect, it } from "vitest";
import {
  addressOf, amountOut, bandForDeposit, bandFromQuote, decrypt, depositDerivation, depositOpening, deriveKeys, encrypt, floorSqrt, hash, inBand, initCrypto, lpBandTerms, MerkleTree, midPriceBand,
  noteCommitment, noteInner, openPair, poolPriceWad, PRICE_NO_LOWER, PRICE_NO_UPPER, randomField, removalEstimate, T_NODE, WAD,
} from "../src";
import { openPairV1, pairCommitmentV1, recordsFor } from "../src/legacy/v1";
import { contractEmptyRoot } from "./helpers";

beforeAll(async () => {
  await initCrypto();
});

describe("tree", () => {
  it("starts at the contract's EMPTY_ROOT", () => {
    // #given an empty depth-32 tree / #when / #then
    expect(new MerkleTree().root()).toBe(contractEmptyRoot());
  });

  it("returns a path that rebuilds the root for every inserted leaf", () => {
    // #given
    const t = new MerkleTree(4);
    const leaves = [11n, 22n, 33n, 44n, 55n];
    leaves.forEach((l) => t.insert(l));
    // #when each leaf's path is folded upward as the circuit does
    const fold = (leaf: bigint, index: number): bigint =>
      t.path(index).reduce((node, sib, level) => ((index >> level) & 1 ? hash([T_NODE, sib, node]) : hash([T_NODE, node, sib])), leaf);
    // #then every fold reaches the root
    expect(leaves.map((l, i) => fold(l, i) === t.root())).toEqual(leaves.map(() => true));
  });
});

describe("note encryption", () => {
  it("decrypts to the plaintext with the recipient key", () => {
    // #given
    const bob = deriveKeys(randomField());
    const pt = [0n, 7n, 1_000n, randomField(), randomField()];
    // #when
    const ct = encrypt(pt, bob.pk, randomField());
    // #then
    expect(decrypt(ct, bob.encSk)).toEqual(pt);
  });

  it("does not rebuild the commitment under another wallet's key", () => {
    // #given a note for bob
    const bob = deriveKeys(1n);
    const eve = deriveKeys(2n);
    const [rho, blind] = [randomField(), randomField()];
    const cm = noteCommitment(9n, 7n, 1_000n, noteInner(bob.owner, rho, blind));
    const ct = encrypt([0n, 7n, 1_000n, rho, blind], addressOf(bob).pk, randomField());
    // #when eve decrypts
    const [, asset, value, r, b] = decrypt(ct, eve.encSk) as [bigint, bigint, bigint, bigint, bigint];
    // #then the result does not open bob's commitment under eve's owner tag
    expect(noteCommitment(9n, asset, value, noteInner(eve.owner, r, b))).not.toBe(cm);
  });
});

describe("deposit openings", () => {
  it("keeps the v1 derivation and binds v2 openings to the deployment", () => {
    // #given one seed on two v2 deployments and one v1 deployment
    const seed = 99n;
    const [a, b] = [(46630n << 160n) | 0x1n, (46630n << 160n) | 0x2n];
    // #then v1 is the pre-M36 hash, and each v2 deployment gets its own openings
    expect(depositOpening(seed, 3, depositDerivation(1, a))).toEqual({ rho: hash([17n, seed, 3n, 3n]), blind: hash([17n, seed, 4n, 3n]) });
    expect(depositOpening(seed, 3)).toEqual(depositOpening(seed, 3, depositDerivation(1, b)));
    expect(depositOpening(seed, 3, depositDerivation(2, a))).toEqual({ rho: hash([17n, seed, 3n, a, 3n]), blind: hash([17n, seed, 4n, a, 3n]) });
    expect(new Set([depositOpening(seed, 3), depositOpening(seed, 3, depositDerivation(2, a)), depositOpening(seed, 3, depositDerivation(2, b))].map((o) => o.rho)).size).toBe(3);
  });
});

describe("LP price bands", () => {
  // Replicas of the spot executor's indicative quote (apps/private-services/src/lib/spot-exec.ts): four significant
  // figures on the output, impact read from reserves cut to four significant figures, in whole bps rounded down.
  const roundDownSig = (x: bigint): bigint => {
    const s = x.toString();
    if (s.length <= 4) return x;
    const scale = 10n ** BigInt(s.length - 4);
    return (x / scale) * scale;
  };
  function quote(amountIn: bigint, r0: bigint, r1: bigint, feeBps: bigint): { amountOut: bigint; priceImpactBps: number } {
    const rIn = roundDownSig(r0);
    const impact = (1_000_000n * ((rIn * 10_000n * 1_000_000n) / (rIn * 10_000n + amountIn * (10_000n - feeBps)))) / 1_000_000n;
    return { amountOut: roundDownSig(amountOut(amountIn, r0, r1, feeBps)), priceImpactBps: 1_000_000n > impact ? Number((1_000_000n - impact) / 100n) : 0 };
  }
  function rng(seed: number): () => bigint {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
      return BigInt(s);
    };
  }

  it("bandFromQuote contains the true mid for every rounding the quote allows", () => {
    // #given random pools across 6 and 18 decimal mixes and trade sizes up to a fifth of the pool
    const next = rng(7);
    let checked = 0;
    const misses: string[] = [];
    for (let i = 0; i < 2_000; i++) {
      const r0 = (next() + 1n) * 10n ** (next() % 13n);
      const r1 = (next() + 1n) * 10n ** (next() % 13n);
      const amountIn = (r0 * (next() % 2_000n + 1n)) / 10_000n;
      const feeBps = [5n, 30n, 100n][Number(next() % 3n)]!;
      if (amountIn === 0n || r0 >= 1n << 96n || r1 >= 1n << 96n) continue;
      const q = quote(amountIn, r0, r1, feeBps);
      const band = midPriceBand(amountIn, q.amountOut, feeBps, q.priceImpactBps);
      if (!band) continue;
      checked++;
      // #when
      const { lo, hi } = bandFromQuote(band, 1);
      // #then the pool's real price is inside, by the circuit's own test
      if (!inBand(r0, r1, lo, hi)) misses.push(`${r0}/${r1} in ${amountIn} fee ${feeBps}`);
    }
    expect({ checked: checked > 1_500, misses }).toEqual({ checked: true, misses: [] });
  });

  it("bandForDeposit always contains the depositor's own ratio", () => {
    const next = rng(11);
    const misses: string[] = [];
    for (let i = 0; i < 1_000; i++) {
      const [d0, d1] = [(next() + 1n) * 10n ** (next() % 12n), (next() + 1n) * 10n ** (next() % 12n)];
      const { lo, hi } = bandForDeposit(d0, d1, 1);
      if (!inBand(d0, d1, lo, hi)) misses.push(`${d0}/${d1}`);
    }
    expect(misses).toEqual([]);
  });

  it("bands round outward, widen by slippage, and refuse empty, inverted or oversized bands", () => {
    // #given P exactly 4
    const at4 = { low: { num: 4n, den: 1n }, high: { num: 4n, den: 1n } };
    // #when / #then
    expect(bandFromQuote(at4, 100)).toEqual({ lo: (4n * WAD * 9_900n) / 10_000n, hi: (4n * WAD * 10_100n) / 10_000n });
    expect(bandForDeposit(3n, 1n, 1).lo).toBeGreaterThan(0n);
    expect(() => bandFromQuote(at4, 0)).toThrow(RangeError);
    expect(() => lpBandTerms(1n, 2n, 0n, 0n)).toThrow("empty band");
    expect(() => lpBandTerms(1n, 2n, -1n, 1n)).toThrow("negative band");
    expect(() => lpBandTerms(1n, 2n, 5n, 4n)).toThrow("inverted band");
    expect(() => lpBandTerms(1n, 2n, 1n, 1n << 128n)).toThrow("band above 128 bits");
    expect(lpBandTerms(1n, 2n, 3n, 5n).map((t) => [t.t2, t.t3, t.t4])).toEqual([[0n, 3n, 2n], [1n, 5n, 2n]]);
  });

  it("removalEstimate never promises more than a removal pays inside the band", () => {
    // #given a pool seeded at P = 4 and then pushed to each edge of [3, 5] by swaps
    const shares = 1_000_000n;
    const supply = floorSqrt(10n ** 9n * 4n * 10n ** 9n);
    const band = { lo: 3n * WAD, hi: 5n * WAD };
    const est = removalEstimate(shares, band);
    // k only grows with fees, so a pool at P has r0 >= supply / sqrt(P) and r1 >= supply * sqrt(P)
    const atEdge = (p: bigint) => ({ r0: floorSqrt((supply * supply * WAD) / p) + 1n, r1: floorSqrt((supply * supply * p) / WAD) + 1n });
    const outs = [atEdge(band.lo), atEdge(band.hi)].map(({ r0, r1 }) => ({ out0: (shares * r0) / supply, out1: (shares * r1) / supply }));
    // #then
    expect(outs.every((o) => o.out0 >= est.out0 && o.out1 >= est.out1)).toBe(true);
  });

  it("accepts a band open on either side, and treats the open edges as no bound", () => {
    // #given lo = 0 (no lower bound) and hi = 2^128 - 1 (no upper bound)
    expect([PRICE_NO_LOWER, PRICE_NO_UPPER]).toEqual([0n, (1n << 128n) - 1n]);
    // #then the lock terms and estimates take them
    expect(lpBandTerms(1n, 2n, PRICE_NO_LOWER, 5n).map((t) => t.t3)).toEqual([0n, 5n]);
    expect(lpBandTerms(1n, 2n, 3n, PRICE_NO_UPPER).map((t) => t.t3)).toEqual([3n, PRICE_NO_UPPER]);
    expect(lpBandTerms(1n, 2n, PRICE_NO_LOWER, PRICE_NO_UPPER).map((t) => t.t3)).toEqual([0n, PRICE_NO_UPPER]);
    expect(removalEstimate(1_000n, { lo: PRICE_NO_LOWER, hi: PRICE_NO_UPPER })).toEqual({ out0: 0n, out1: 0n });
    // a price far past what a 128-bit edge could hold is still inside a band with no upper bound
    expect([inBand(1n, 1n << 120n, 0n, PRICE_NO_UPPER), inBand(1n, 1n << 120n, 0n, PRICE_NO_UPPER - 1n), inBand(1n, 0n, 0n, 1n)]).toEqual([true, false, true]);
  });

  it("midPriceBand refuses a quote under 1000 base units and lowers the low edge for the impact read from rounded reserves", () => {
    expect(midPriceBand(10n ** 18n, 999n, 30n, 0)).toBeNull();
    // ceil(2500 / 1000) + 1 = 4 bps off the low edge
    expect(midPriceBand(10n ** 18n, 1_000n, 30n, 2_500)?.low).toEqual({ num: 1_000n * 10_000n * 9_996n, den: 10n ** 18n * 9_970n * 7_500n });
    expect(midPriceBand(10n ** 18n, 1_000n, 30n, 0)?.low).toEqual({ num: 1_000n * 10_000n * 9_999n, den: 10n ** 18n * 9_970n * 10_000n });
  });

  it("poolPriceWad and inBand agree with the circuit's cross-multiplication at the edges", () => {
    expect([poolPriceWad(10n ** 6n, 4n * 10n ** 6n), inBand(10n ** 6n, 4n * 10n ** 6n, 4n * WAD, 4n * WAD), inBand(10n ** 6n, 4n * 10n ** 6n, 4n * WAD + 1n, 5n * WAD)])
      .toEqual([4n * WAD, true, false]);
  });
});

describe("legacy v1 reader", () => {
  it("opens a v1 pair only under the v1 layout and picks the reader by record version", () => {
    // #given a v1 pair encrypted to its taker
    const taker = deriveKeys(3n);
    const p = {
      market: 1n, asset: 2n, isShort: 0n, size: WAD, entry: WAD, fundingIndex: 1n << 128n, closeSpread: 10n, fundingDebt: 0n, debtByTaker: 0n, lastReduce: 0n,
      takerMargin: 5n, makerMargin: 6n, takerAuth: taker.auth, takerX: taker.pk.x, takerY: taker.pk.y, makerAuth: 7n, makerX: 8n, makerY: 9n, recNonce: 10n, blind: 11n,
    };
    const ct = encrypt(Object.values(p), taker.pk, randomField());
    const cm = pairCommitmentV1(9n, p);
    // #when / #then
    expect({ v1: openPairV1(ct, taker.encSk, 9n, cm), v2: openPair(ct, taker.encSk, 9n, cm), readers: [recordsFor(1n), recordsFor(2n)] })
      .toEqual({ v1: p, v2: null, readers: ["v1", "current"] });
    expect(() => recordsFor(3n)).toThrow("unknown record version");
  });
});
