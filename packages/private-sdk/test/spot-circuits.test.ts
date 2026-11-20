import { Noir } from "@noir-lang/noir_js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  addressOf, amountOut, deriveKeys, EMPTY_POOL, initCrypto, inBand, keyPopWitness, lockCommitment, lpAddWitness, lpBandTerms, lpCommitment, lpRemoveWitness,
  lpSetWitness, MerkleTree, openPoolState, poolHead, PRICE_NO_LOWER, PRICE_NO_UPPER, protocolCut, scanCreated, swapTerms, sweepProtocolWitness, swapWitness, toHex32, WAD,
  type HeldLock, type LockTerms, type LpRecord, type PoolInfo, type PoolState, type WalletKeys,
} from "../src";
import { circuit } from "./helpers";

const DEPLOYMENT = (46630n << 160n) | 0x1234n;
const TOKEN0 = 0xa0n;
const TOKEN1 = 0xb0n;
const POOL = 1n;
const NOW = 1_000_000n;
// P = 4: 1e9 token0 against 4e9 token1.
const R0 = 1_000_000_000n;
const R1 = 4_000_000_000n;

let owner: WalletKeys;
let k1: WalletKeys;
let k2: WalletKeys;
let k3: WalletKeys;
let feeKeys: WalletKeys;

beforeAll(async () => {
  await initCrypto();
  [owner, k1, k2, k3, feeKeys] = [deriveKeys(101n), deriveKeys(102n), deriveKeys(103n), deriveKeys(104n), deriveKeys(105n)];
});

const execute = (name: string, inputs: Parameters<Noir["execute"]>[0]) => new Noir(circuit(name)).execute(inputs);
const poolKeys = () => [k1.pk, k2.pk, k3.pk] as const;

function pool(state: PoolState, protocolBps = 0n): PoolInfo {
  return { id: POOL, token0: TOKEN0, token1: TOKEN1, feeBps: 30n, protocolBps, state, head: state.supply === 0n ? 0n : poolHead(DEPLOYMENT, POOL, state) };
}

const seeded = (over: Partial<PoolState> = {}): PoolState => ({ r0: R0, r1: R1, supply: 2_000_000_000n, lastLeaf: 0n, proto0: 0n, proto1: 0n, blind: 9n, ...over });

function heldLock(tree: MerkleTree, terms: LockTerms, asset: bigint, amount: bigint, nonce: bigint): HeldLock {
  const record = { ...terms, asset, amount, ownerAuth: owner.auth, ownerX: owner.pk.x, ownerY: owner.pk.y, expiry: NOW + 600n, recNonce: nonce, blind: nonce + 1n };
  return { record, leafIndex: tree.insert(lockCommitment(DEPLOYMENT, record)) };
}

describe("swap protocol share", () => {
  function swap(protocolBps: bigint) {
    const tree = new MerkleTree();
    const held = heldLock(tree, swapTerms(POOL, 1n), TOKEN0, 10_000_000n, 11n);
    return swapWitness({ held, deployment: DEPLOYMENT, tree, pools: [pool(seeded(), protocolBps)], asOf: NOW, keys: poolKeys() });
  }

  it("with share 0 leaves reserves exactly as before", async () => {
    // #given / #when
    const w = swap(0n);
    await execute("swap", w.inputs);
    // #then
    const out = amountOut(10_000_000n, R0, R1, 30n);
    expect(w.next[0]).toMatchObject({ r0: R0 + 10_000_000n, r1: R1 - out, proto0: 0n, proto1: 0n });
  }, 60_000);

  it("with a share accrues the cut on the input side and pays the trader the same", async () => {
    // #given a quarter of a 30 bps fee on 10,000,000 in: 7,500
    const w = swap(2_500n);
    await execute("swap", w.inputs);
    // #then
    expect([w.out, w.next[0]!.r0, w.next[0]!.proto0, w.next[0]!.proto1, protocolCut(10_000_000n, 30n, 2_500n)]).toEqual([swap(0n).out, R0 + 10_000_000n - 7_500n, 7_500n, 0n, 7_500n]);
  }, 60_000);

  it("rejects a protocol share above BPS", async () => {
    // #given a valid witness whose share is raised after the fact
    const w = swap(0n);
    w.inputs.protocol_bps = [toHex32(10_001n), toHex32(0n)];
    // #when / #then
    await expect(execute("swap", w.inputs)).rejects.toThrow();
    expect(() => protocolCut(1n, 30n, 10_001n)).toThrow("protocol share above BPS");
  }, 60_000);
});

describe("lp_add price band", () => {
  function add(state: PoolState, lo: bigint, hi: bigint, apart = false) {
    const tree = new MerkleTree();
    if (state.lastLeaf === 0n && state.supply !== 0n) tree.insert(1n);
    const [t0, t1] = lpBandTerms(POOL, 77n, lo, hi);
    const lock0 = heldLock(tree, t0, TOKEN0, 1_000_000n, 21n);
    if (apart) tree.insert(2n);
    const lock1 = heldLock(tree, t1, TOKEN1, 4_000_000n, 31n);
    const claimed = apart ? { ...lock1, leafIndex: lock0.leafIndex + 1 } : lock1;
    const w = lpAddWitness({ lock0, lock1: claimed, pool: pool(state), deployment: DEPLOYMENT, tree, asOf: NOW, keys: poolKeys() });
    if (apart) Object.assign(w.inputs.lock1 as object, { index: toHex32(BigInt(lock1.leafIndex)), path: tree.path(lock1.leafIndex).map(toHex32) });
    return w;
  }

  it("accepts a pool price inside the band and at its edges", async () => {
    await execute("lp_add", add(seeded(), 3n * WAD, 5n * WAD).inputs);
    await execute("lp_add", add(seeded(), 4n * WAD, 4n * WAD).inputs);
  }, 60_000);

  it("rejects a pool price below the band", async () => {
    await expect(execute("lp_add", add(seeded(), 4n * WAD + 1n, 5n * WAD).inputs)).rejects.toThrow("price below band");
  }, 60_000);

  it("rejects a pool price above the band", async () => {
    await expect(execute("lp_add", add(seeded(), 3n * WAD, 4n * WAD - 1n).inputs)).rejects.toThrow("price above band");
  }, 60_000);

  it("on an empty pool checks the depositor's own ratio", async () => {
    // #given 1e6 against 4e6, P = 4
    await execute("lp_add", add(EMPTY_POOL, 4n * WAD, 4n * WAD).inputs);
    await expect(execute("lp_add", add(EMPTY_POOL, 5n * WAD, 6n * WAD).inputs)).rejects.toThrow("price below band");
  }, 60_000);

  it("rejects locks two leaves apart, in the SDK and in the circuit", async () => {
    await expect(execute("lp_add", add(seeded(), 3n * WAD, 5n * WAD, true).inputs)).rejects.toThrow("LP locks not adjacent");
    const tree = new MerkleTree();
    const [t0, t1] = lpBandTerms(POOL, 77n, WAD, 5n * WAD);
    const lock0 = heldLock(tree, t0, TOKEN0, 1n, 1n);
    tree.insert(2n);
    const lock1 = heldLock(tree, t1, TOKEN1, 1n, 3n);
    expect(() => lpAddWitness({ lock0, lock1, pool: pool(seeded()), deployment: DEPLOYMENT, tree, asOf: NOW, keys: poolKeys() })).toThrow("LP locks not adjacent");
  }, 60_000);

  it("carries the protocol accruals unchanged and sets last_leaf to the second lock", async () => {
    // #given a pool holding accruals
    const w = add(seeded({ proto0: 5n, proto1: 6n }), 3n * WAD, 5n * WAD);
    await execute("lp_add", w.inputs);
    // #then
    expect([w.next.proto0, w.next.proto1, w.next.lastLeaf]).toEqual([5n, 6n, 3n]);
  }, 60_000);
});

describe("lp_set and lp_remove price band", () => {
  const claim = (over: Partial<LpRecord> = {}): LpRecord => ({
    pool: POOL, shares: 1_000_000n, ownerAuth: owner.auth, ownerX: owner.pk.x, ownerY: owner.pk.y, expiry: 0n, priceLo: 0n, priceHi: 0n, recNonce: 51n, blind: 52n, ...over,
  });

  function set(lo: bigint, hi: bigint) {
    const c = claim();
    const tree = new MerkleTree();
    const leafIndex = tree.insert(lpCommitment(DEPLOYMENT, c));
    return lpSetWitness({ claim: c, leafIndex, deployment: DEPLOYMENT, tree, mode: 0n, sk: owner.sk, priceLo: lo, priceHi: hi, expiry: NOW + 60n, asOf: NOW, keys: poolKeys() });
  }

  it("lp_set commits a band and rejects an inverted one", async () => {
    // #given a valid request whose band is inverted after the fact
    const w = set(3n * WAD, 5n * WAD);
    const inverted = structuredClone(w.inputs);
    inverted.price_hi = toHex32(2n * WAD);
    // #when / #then
    await execute("lp_set", w.inputs);
    expect([w.record.priceLo, w.record.priceHi]).toEqual([3n * WAD, 5n * WAD]);
    await expect(execute("lp_set", inverted)).rejects.toThrow("inverted band");
    expect(() => set(5n * WAD, 3n * WAD)).toThrow("inverted band");
    expect(() => set(0n, 0n)).toThrow("empty band");
    expect([set(PRICE_NO_LOWER, 3n * WAD).record.priceLo, set(3n * WAD, PRICE_NO_UPPER).record.priceHi]).toEqual([0n, PRICE_NO_UPPER]);
  }, 60_000);

  function remove(lo: bigint, hi: bigint, state = seeded()) {
    const c = claim({ expiry: NOW + 60n, priceLo: lo, priceHi: hi });
    const tree = new MerkleTree();
    tree.insert(1n);
    const leafIndex = tree.insert(lpCommitment(DEPLOYMENT, c));
    return lpRemoveWitness({ claim: c, leafIndex, pool: pool(state), deployment: DEPLOYMENT, tree, asOf: NOW, keys: poolKeys() });
  }

  it("lp_remove runs inside the band, carries accruals, and rejects a price outside it", async () => {
    const w = remove(3n * WAD, 5n * WAD, seeded({ proto0: 5n, proto1: 6n }));
    await execute("lp_remove", w.inputs);
    expect([w.next.proto0, w.next.proto1, inBand(R0, R1, 3n * WAD, 5n * WAD)]).toEqual([5n, 6n, true]);
    await expect(execute("lp_remove", remove(4n * WAD + 1n, 5n * WAD).inputs)).rejects.toThrow("price below band");
    await expect(execute("lp_remove", remove(3n * WAD, 4n * WAD - 1n).inputs)).rejects.toThrow("price above band");
  }, 60_000);
});

describe("sweep_protocol", () => {
  it("pays both accruals to the fee address and zeroes them", async () => {
    // #given a pool holding 7,500 of token0 and 300 of token1 for the protocol
    const state = seeded({ proto0: 7_500n, proto1: 300n, lastLeaf: 4n });
    const w = sweepProtocolWitness({ pool: pool(state), deployment: DEPLOYMENT, feeTo: addressOf(feeKeys), keys: poolKeys() });
    // #when
    await execute("sweep_protocol", w.inputs);
    const found = scanCreated(feeKeys, DEPLOYMENT, [{ firstLeafIndex: 0, commitments: w.publicInputs.outCommitments.map(BigInt), ciphertexts: w.publicInputs.outCt.map((c) => c.map(BigInt)) }]);
    const reopened = openPoolState(w.publicInputs.poolCt[0]!.map(BigInt), k1.encSk);
    // #then
    expect({
      paid: found.map((n) => [n.asset, n.value]),
      reopened: { ...reopened, blind: 0n },
      head: BigInt(w.publicInputs.newHead) === poolHead(DEPLOYMENT, POOL, reopened),
    }).toEqual({ paid: [[TOKEN0, 7_500n], [TOKEN1, 300n]], reopened: { ...state, proto0: 0n, proto1: 0n, blind: 0n }, head: true });
  }, 60_000);

  it("refuses an empty accrual", async () => {
    // #given a witness whose input state is swapped for one with nothing accrued
    const w = sweepProtocolWitness({ pool: pool(seeded({ proto0: 1n })), deployment: DEPLOYMENT, feeTo: addressOf(feeKeys), keys: poolKeys() });
    const empty = seeded();
    w.inputs.state = { ...(w.inputs.state as object), proto0: toHex32(0n) };
    w.inputs.head = toHex32(poolHead(DEPLOYMENT, POOL, empty));
    // #when / #then
    await expect(execute("sweep_protocol", w.inputs)).rejects.toThrow("nothing to sweep");
    expect(() => sweepProtocolWitness({ pool: pool(empty), deployment: DEPLOYMENT, feeTo: addressOf(feeKeys), keys: poolKeys() })).toThrow("nothing to sweep");
  }, 60_000);
});

describe("key_pop", () => {
  it("proves the holder of a key and rejects another key", async () => {
    const w = keyPopWitness({ encSk: k1.encSk, deployment: DEPLOYMENT, epoch: 2n, slot: 1n });
    await execute("key_pop", w.inputs);
    expect(w.publicInputs.key).toEqual(k1.pk);
    const other = structuredClone(w.inputs);
    other.x = toHex32(k2.pk.x);
    await expect(execute("key_pop", other)).rejects.toThrow("not this key");
  }, 60_000);
});

describe("public input order", () => {
  // internal/engineering/m36/public-inputs.md; PairInputs.sol and PrivateSpot build their arrays in this order.
  const expected: Record<string, [string, number]> = {
    lock: ["root nf cm_change cm_lock ct_change ct_owner ct_coordinator deployment coordinator_pk ct_risk risk_pk as_of max_lifetime cm_relay ct_relay", 90],
    pair_update: ["root nf cm_pair cm_out cm_fee ct_pair ct_out ct_fee deployment market asset mark imr_wad scale fee_bps funding_index delta_cm risk_pk fee_auth fee_pk carried_nf mmr_wad as_of min_gap cm_relay ct_relay", 140],
    open_pair: ["root nf cm_pair cm_refund ct_pair ct_refund deployment market asset mark now imr_wad scale risk_pk funding_index delta_cm cm_fee ct_fee fee_bps fee_auth fee_pk head oi_pending max_oi_usd max_pair_size max_close_spread", 134],
    close_pair: ["root nf cm_out ct deployment market asset mark scale funding_index delta_cm mode fee_bps fee_auth fee_pk cm_relay ct_relay", 46],
    release: ["root nf cm_out ct deployment now cm_relay ct_relay", 20],
    redeem_claim: ["root nf cm_out ct deployment delta_cm ratio cm_relay ct_relay", 21],
    funding_epoch: ["deployment market head new_head count delta_cm dt mark max_rate_wad index_mag index_neg claim_ratio bond_total keys ct bond_used_prev bond_used_next", 52],
    swap: ["root nf cm_out ct_out deployment now pool token0 token1 fee_bps protocol_bps head new_head ct_pool keys", 86],
    lp_add: ["root nf head new_head cm_lp ct_lp cm_refund ct_refund ct_pool deployment now pool token0 token1 keys", 108],
    lp_set: ["root nf cm_next ct deployment now mode keys", 60],
    lp_remove: ["root nf head new_head cm_out ct_out ct_pool deployment now pool token0 token1 keys", 58],
    sweep_protocol: ["head new_head cm_out ct_out ct_pool deployment pool token0 token1 fee_auth fee_pk keys", 58],
    key_pop: ["deployment epoch slot x y", 5],
  };
  type AbiType = { kind: string; length?: number; type?: AbiType; fields?: { type: AbiType }[] };
  const width = (t: AbiType): number =>
    t.kind === "array" ? t.length! * width(t.type!) : t.kind === "struct" ? t.fields!.reduce((a, x) => a + width(x.type), 0) : 1;

  it("matches the M36 checklist for every changed circuit", () => {
    const actual = Object.fromEntries(Object.keys(expected).map((name) => {
      const params = (circuit(name).abi.parameters as { name: string; visibility: string; type: AbiType }[]).filter((p) => p.visibility === "public");
      return [name, [params.map((p) => p.name).join(" "), params.reduce((a, p) => a + width(p.type), 0)]];
    }));
    expect(actual).toEqual(expected);
  });
});
