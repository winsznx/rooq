import { beforeAll, describe, expect, it } from "vitest";
import { encrypt } from "../src/encryption";
import { initCrypto, mulGenerator } from "../src/crypto";
import { KeyRing, openMarketState, openPoolStateWith } from "../src/keyring";
import { marketHead, type MarketState } from "../src/pairs";
import { poolHead, type PoolState } from "../src/spot";

const OLD = 0xa1a1n;
const NEW = 0xa2a2n;
const DEPLOYMENT = 7n;
const MARKET_STATE: MarketState = { longOi: 3n, shortOi: 1n, insurance: 9n, badDebt: 0n, bondUsed: 2n, blind: 55n };
const marketPlain = (s: MarketState): bigint[] => [s.longOi, s.shortOi, s.insurance, s.badDebt, s.bondUsed, s.blind];

describe("KeyRing", () => {
  beforeAll(initCrypto);

  it("finds a key by its public point and reports the ones it does not hold", () => {
    const ring = new KeyRing([NEW, OLD]);
    expect(ring.indexOf(mulGenerator(OLD))).toBe(1);
    expect(ring.indexOf(mulGenerator(0xdeadn))).toBe(-1);
  });

  it("removes duplicate keys and refuses an empty ring", () => {
    expect(new KeyRing([OLD, OLD]).keys).toHaveLength(1);
    expect(() => new KeyRing([])).toThrow("at least one key");
  });

  it("opens with the key that fits, and returns null when none does", () => {
    const ring = new KeyRing([NEW, OLD]);
    const hit = ring.open((sk) => (sk === OLD ? "record" : null));
    expect(hit).toEqual({ value: "record", keyIndex: 1 });
    expect(ring.open(() => null)).toBeNull();
  });

  it("opens a market record only with the key whose decryption matches the on-chain head", () => {
    const ct = encrypt(marketPlain(MARKET_STATE), mulGenerator(OLD), 123n);
    const head = marketHead(DEPLOYMENT, 1n, MARKET_STATE);
    const opened = openMarketState(new KeyRing([NEW, OLD]), ct, DEPLOYMENT, 1n, head);
    expect(opened).toEqual({ value: MARKET_STATE, keyIndex: 1 });
    expect(openMarketState(new KeyRing([NEW]), ct, DEPLOYMENT, 1n, head)).toBeNull();
  });

  it("opens a pool record by matching its head the same way", () => {
    const state: PoolState = { r0: 4n, r1: 8n, supply: 2n, lastLeaf: 1n, blind: 3n };
    const ct = encrypt([state.r0, state.r1, state.supply, state.lastLeaf, state.blind], mulGenerator(OLD), 321n);
    const head = poolHead(DEPLOYMENT, 2n, state);
    expect(openPoolStateWith(new KeyRing([OLD, NEW]), ct, DEPLOYMENT, 2n, head)).toEqual({ value: state, keyIndex: 0 });
    expect(openPoolStateWith(new KeyRing([NEW]), ct, DEPLOYMENT, 2n, head)).toBeNull();
  });
});
