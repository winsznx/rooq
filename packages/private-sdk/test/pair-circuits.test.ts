import { Noir } from "@noir-lang/noir_js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  addressOf, ACTOR_MAKER, ACTOR_NONE, ACTOR_TAKER, claimCommitment, CLOSE_MATURED, closeWitness, decrypt, deriveKeys, FUNDING_INDEX_ZERO, fundingEpochWitness,
  initCrypto, isOnCurve, lockAddressKeys, marketHead, lockCommitment, lockWitness, makerTerms, MAX_INTENT_LIFETIME, MAX_MAKER_LIFETIME, MerkleTree, nextUpdateAt,
  noteCommitment, noteInner, OI_CLOSE, OI_OPEN, OI_REDUCE, oiDeltaCommitment, openPairWitness, ownerNullifier, pairCommitment, redeemWitness, releaseWitness,
  ROLE_LP, ROLE_SWAP, scanCreated, TAKER_GRACE, takerTerms, toHex32, updateOutcome, updateWitness, WAD, zeroRelayFee,
  type ClaimRecord, type FeeOut, type LockRecord, type LockTerms, type OwnedNote, type PairRecord, type WalletKeys,
} from "../src";
import { circuit } from "./helpers";

const DEPLOYMENT = (46630n << 160n) | 0x1234n;
const USDG = 0x7e955252e15c84f5768b83c41a71f9eba181802fn;
const USD = 1_000_000n;
const SCALE = 10n ** 12n;
const MARK = 250n * WAD;
const IMR = WAD / 10n;
const MMR = WAD / 20n;
const OPENED_AT = 1_000_000n;
const GAP = 600n;

let taker: WalletKeys;
let maker: WalletKeys;
let worker: WalletKeys;
let relayer: WalletKeys;
let wallet: WalletKeys;

beforeAll(async () => {
  await initCrypto();
  [taker, maker, worker, relayer, wallet] = [deriveKeys(11n), deriveKeys(22n), deriveKeys(33n), deriveKeys(44n), deriveKeys(55n)];
});

const execute = (name: string, inputs: Parameters<Noir["execute"]>[0]) => new Noir(circuit(name)).execute(inputs);

function ownedNote(keys: WalletKeys, tree: MerkleTree, value: bigint, rho: bigint): OwnedNote {
  const blind = rho + 1n;
  const cm = noteCommitment(DEPLOYMENT, USDG, value, noteInner(keys.owner, rho, blind));
  return { leafIndex: tree.insert(cm), asset: USDG, value, rho, blind, commitment: cm, nullifier: ownerNullifier(keys.nk, cm) };
}

/** What a wallet's scanner finds in a relay fee output. */
function scanFee(keys: WalletKeys, fee: FeeOut) {
  return scanCreated(keys, DEPLOYMENT, [{ firstLeafIndex: 0, commitments: [BigInt(fee.commitment)], ciphertexts: [fee.ct.map(BigInt)] }]);
}

const publicShape = (x: unknown): string => JSON.stringify(x, (_, v: unknown) => (typeof v === "bigint" ? "n" : typeof v === "string" ? "s" : v));

describe("relay fee output", () => {
  function lockFor(fee?: { value: bigint; to: ReturnType<typeof addressOf> }) {
    const tree = new MerkleTree();
    const note = ownedNote(wallet, tree, 1_000n * USD, 7n);
    return lockWitness({
      keys: wallet, deployment: DEPLOYMENT, tree, asset: USDG, inputs: [note], amount: 300n * USD, terms: takerTerms(3n, false, WAD, 300n * WAD),
      expiry: OPENED_AT + 3_600n, coordinator: worker.pk, riskKeys: [maker.pk, worker.pk], payout: addressOf(lockAddressKeys(5n, 0)), view: wallet.pk,
      asOf: OPENED_AT, ...(fee ? { relayFee: fee } : {}),
    });
  }

  it("defaults to a zero-value note to the wallet itself, shaped like a paid one", async () => {
    // #given a lock with no fee and one paying a relayer
    const free = lockFor();
    const paid = lockFor({ value: 2n * USD, to: addressOf(relayer) });
    // #when both run through the circuit and each recipient scans its fee output
    await execute("lock", free.inputs);
    await execute("lock", paid.inputs);
    const ownZero = scanFee(wallet, free.publicInputs.relayFee);
    const relayerFee = scanFee(relayer, paid.publicInputs.relayFee);
    const eph = free.publicInputs.relayFee.ct.slice(0, 2).map(BigInt);
    // #then the zero note is the wallet's own, the paid one the relayer's, and nothing public tells them apart
    expect({
      ownZero: ownZero.map((n) => n.value),
      relayerFee: relayerFee.map((n) => n.value),
      relayerSeesZero: scanFee(relayer, free.publicInputs.relayFee).length,
      shape: publicShape(free.publicInputs) === publicShape(paid.publicInputs),
      ctLength: free.publicInputs.relayFee.ct.length,
      ephOnCurve: isOnCurve({ x: eph[0]!, y: eph[1]! }),
    }).toEqual({ ownZero: [0n], relayerFee: [2n * USD], relayerSeesZero: 0, shape: true, ctLength: 7, ephOnCurve: true });
  }, 60_000);

  it("takes the fee out of the lock's inputs, and the circuit refuses a fee that isn't deducted", async () => {
    // #given a paid lock
    const w = lockFor({ value: 2n * USD, to: addressOf(relayer) });
    const change = decrypt(w.publicInputs.changeCt.map(BigInt), wallet.encSk);
    // #when the change is raised by the fee after the fact
    const tampered = structuredClone(w.inputs);
    (tampered.change as { value: string }).value = toHex32(change[2]! + 2n * USD);
    // #then the change already excludes it, and conservation fails on the tampered witness
    expect(change[2]).toBe(698n * USD);
    await expect(execute("lock", tampered)).rejects.toThrow();
  }, 60_000);

  it("rejects a relay ciphertext that doesn't encrypt the committed note, and a fee past 100 bits", async () => {
    // #given a valid zero-fee lock
    const w = lockFor();
    const badCt = structuredClone(w.inputs);
    (badCt.ct_relay as string[])[4] = toHex32(1n);
    const huge = structuredClone(w.inputs);
    (huge.relay as { value: string }).value = toHex32(1n << 100n);
    // #when / #then
    await expect(execute("lock", badCt)).rejects.toThrow("wrong relay fee ciphertext");
    await expect(execute("lock", huge)).rejects.toThrow();
    expect(() => lockFor({ value: 1n << 100n, to: addressOf(relayer) })).toThrow(RangeError);
  }, 60_000);
});

describe("lock lifetime and terms", () => {
  function lock(terms: LockTerms, expiry: bigint, maxLifetime?: readonly [bigint, bigint]) {
    const tree = new MerkleTree();
    const note = ownedNote(wallet, tree, 1_000n * USD, 9n);
    return lockWitness({
      keys: wallet, deployment: DEPLOYMENT, tree, asset: USDG, inputs: [note], amount: 100n * USD, terms, expiry, coordinator: worker.pk,
      riskKeys: [maker.pk, worker.pk], payout: addressOf(lockAddressKeys(5n, 1)), view: wallet.pk, asOf: OPENED_AT, ...(maxLifetime ? { maxLifetime } : {}),
    });
  }

  it("refuses an intent expiring past as_of + 7 days and accepts a maker lock at 30 days", async () => {
    // #given an intent one second past its cap, proved against a looser cap and then checked against the real one
    const intent = takerTerms(3n, false, WAD, 300n * WAD);
    const late = OPENED_AT + MAX_INTENT_LIFETIME + 1n;
    const loose = lock(intent, late, [MAX_MAKER_LIFETIME, MAX_MAKER_LIFETIME]);
    loose.inputs.max_lifetime = [MAX_INTENT_LIFETIME, MAX_MAKER_LIFETIME].map(toHex32);
    // #when / #then the SDK and the circuit both refuse it, and a maker at exactly 30 days runs
    expect(() => lock(intent, late)).toThrow("lock lifetime");
    await expect(execute("lock", loose.inputs)).rejects.toThrow("lock outlives the maximum");
    await execute("lock", lock(intent, OPENED_AT + MAX_INTENT_LIFETIME).inputs);
    await execute("lock", lock(makerTerms(3n, 10n, WAD, 40n), OPENED_AT + MAX_MAKER_LIFETIME).inputs);
  }, 60_000);

  it("accepts a 128-bit LP bound, rejects a 129-bit one, and still caps swap t3 at 96 bits", async () => {
    // #given
    const lp = (t3: bigint) => lock({ role: ROLE_LP, market: 9n, t2: 1n, t3, t4: 77n }, OPENED_AT + 60n);
    const swap = (t3: bigint) => lock({ role: ROLE_SWAP, market: 9n, t2: 0n, t3, t4: 0n }, OPENED_AT + 60n);
    // #when / #then
    await execute("lock", lp((1n << 128n) - 1n).inputs);
    await expect(execute("lock", lp(1n << 128n).inputs)).rejects.toThrow();
    await execute("lock", swap((1n << 96n) - 1n).inputs);
    await expect(execute("lock", swap(1n << 96n).inputs)).rejects.toThrow();
  }, 60_000);
});

describe("keyless paths pay a fee only with the owner key", () => {
  it("release: zero fee without a key, a paid fee with the lock's key, never with another key", async () => {
    // #given an expired lock paying out to a one-time address
    const payout = lockAddressKeys(5n, 2);
    const record: LockRecord = {
      ...takerTerms(3n, false, WAD, 300n * WAD), asset: USDG, amount: 50n * USD, ownerAuth: payout.auth, ownerX: payout.pk.x, ownerY: payout.pk.y,
      expiry: OPENED_AT - 1n, recNonce: 31n, blind: 32n,
    };
    const tree = new MerkleTree();
    const held = { record, leafIndex: tree.insert(lockCommitment(DEPLOYMENT, record)) };
    const fee = { value: USD, to: addressOf(relayer) };
    // #when
    const keyless = releaseWitness({ held, deployment: DEPLOYMENT, tree, asOf: OPENED_AT });
    const paid = releaseWitness({ held, deployment: DEPLOYMENT, tree, asOf: OPENED_AT, sk: payout.sk, relayFee: fee });
    const stolen = structuredClone(paid.inputs);
    stolen.sk = toHex32(worker.sk);
    // #then
    await execute("release", keyless.inputs);
    await execute("release", paid.inputs);
    await expect(execute("release", stolen)).rejects.toThrow("fee needs the owner key");
    expect(() => releaseWitness({ held, deployment: DEPLOYMENT, tree, asOf: OPENED_AT, relayFee: fee })).toThrow("fee needs the owner key");
    expect(() => releaseWitness({ held, deployment: DEPLOYMENT, tree, asOf: OPENED_AT, sk: payout.sk, relayFee: { value: 51n * USD, to: fee.to } })).toThrow("fee above available");
    expect([keyless.value, paid.value, scanFee(payout, keyless.publicInputs.relayFee).length]).toEqual([50n * USD, 49n * USD, 1]);
  }, 60_000);

  it("redeem_claim: zero fee without a key, a paid fee with the claim owner's key", async () => {
    // #given a folded claim of 40 paid at 75%
    const claim: ClaimRecord = { market: 3n, asset: USDG, amount: 40n * USD, ownerAuth: taker.auth, ownerX: taker.pk.x, ownerY: taker.pk.y, insIn: 0n, pairNonce: 1n, deltaCm: 99n, recNonce: 41n, blind: 42n };
    const tree = new MerkleTree();
    const leafIndex = tree.insert(claimCommitment(DEPLOYMENT, claim));
    const ratio = (WAD * 3n) / 4n;
    const fee = { value: USD, to: addressOf(relayer) };
    // #when
    const keyless = redeemWitness({ claim, leafIndex, deployment: DEPLOYMENT, tree, ratio });
    const paid = redeemWitness({ claim, leafIndex, deployment: DEPLOYMENT, tree, ratio, sk: taker.sk, relayFee: fee });
    const stolen = structuredClone(paid.inputs);
    stolen.sk = toHex32(worker.sk);
    // #then
    await execute("redeem_claim", keyless.inputs);
    await execute("redeem_claim", paid.inputs);
    await expect(execute("redeem_claim", stolen)).rejects.toThrow("fee needs the owner key");
    expect([keyless.value, paid.value, scanFee(relayer, paid.publicInputs.relayFee).map((n) => n.value)]).toEqual([30n * USD, 29n * USD, [USD]]);
  }, 60_000);

  it("close_pair: a matured close by a keyless prover pays zero; the taker's key can pay from its payout", async () => {
    // #given a flat pair
    const pair = pairWith(150n * USD, 500n * USD);
    const tree = treeWith(pair);
    const base = { pair, leafIndex: 0, deployment: DEPLOYMENT, tree, mode: CLOSE_MATURED, mark: MARK, scale: SCALE, fundingIndex: FUNDING_INDEX_ZERO, feeBps: 10n, feeTo: addressOf(worker) };
    const fee = { value: 2n * USD, to: addressOf(relayer) };
    // #when
    const keyless = closeWitness({ ...base, sk: 0n });
    const paid = closeWitness({ ...base, sk: taker.sk, relayFee: fee });
    const stolen = structuredClone(paid.inputs);
    stolen.sk = toHex32(worker.sk);
    // #then
    await execute("close_pair", keyless.inputs);
    await execute("close_pair", paid.inputs);
    await expect(execute("close_pair", stolen)).rejects.toThrow("fee needs the owner key");
    expect(() => closeWitness({ ...base, sk: 0n, relayFee: fee })).toThrow("fee needs the owner key");
    expect([keyless.takerOut, paid.takerOut]).toEqual([150n * USD, 148n * USD]);
  }, 60_000);
});

function pairWith(takerMargin: bigint, makerMargin: bigint, updatedAt = OPENED_AT): PairRecord {
  return {
    market: 3n, asset: USDG, isShort: 0n, size: 4n * WAD, entry: MARK, fundingIndex: FUNDING_INDEX_ZERO, closeSpread: 10n, fundingDebt: 0n, debtByTaker: 0n, lastReduce: 0n,
    updatedAt, takerMargin, makerMargin, takerAuth: taker.auth, takerX: taker.pk.x, takerY: taker.pk.y, makerAuth: maker.auth, makerX: maker.pk.x, makerY: maker.pk.y,
    recNonce: 5n, blind: 6n,
  };
}

function treeWith(p: PairRecord): MerkleTree {
  const tree = new MerkleTree();
  tree.insert(pairCommitment(DEPLOYMENT, p));
  return tree;
}

describe("pair_update health, cooldown and cure", () => {
  // A long of 4 at 250 on a 6-decimal asset: initial margin 100, maintenance 50, flat, no funding moving.
  function update(takerMargin: bigint, actor: bigint, add: bigint, asOf: bigint, relayFee?: { value: bigint; to: ReturnType<typeof addressOf> }) {
    const pair = pairWith(takerMargin, 500n * USD);
    const tree = treeWith(pair);
    const note = ownedNote(wallet, tree, 100n * USD, 61n);
    return updateWitness({
      pair, leafIndex: 0, deployment: DEPLOYMENT, tree, update: { actor, add, remove: 0n, reduce: 0n }, sk: actor === ACTOR_MAKER ? maker.sk : actor === ACTOR_TAKER ? taker.sk : 0n,
      noteOwner: wallet, note, mark: MARK, imrWad: IMR, mmrWad: MMR, scale: SCALE, feeBps: 10n, fundingIndex: FUNDING_INDEX_ZERO, riskKeys: [maker.pk, worker.pk],
      feeTo: addressOf(worker), asOf, minGap: GAP, ...(relayFee ? { relayFee } : {}),
    });
  }

  /** The SDK's refusal is the circuit's error, and the SDK accepts exactly what the circuit does. */
  async function agree(w: ReturnType<typeof update>): Promise<string | null> {
    if (w.outcome.refused) await expect(execute("pair_update", w.inputs)).rejects.toThrow(w.outcome.refused);
    else await execute("pair_update", w.inputs);
    return w.outcome.refused;
  }

  const inside = OPENED_AT + GAP - 1n;
  const after = OPENED_AT + GAP;
  const afterGrace = after + TAKER_GRACE;

  it("refuses a keyless no-op on a liquidatable pair (#4)", async () => {
    expect(await agree(update(40n * USD, ACTOR_NONE, 0n, afterGrace))).toBe("update leaves pair liquidatable");
  }, 60_000);

  it("refuses a maker add of 0, and a taker add above initial margin, inside the cooldown (#5)", async () => {
    expect(await agree(update(150n * USD, ACTOR_MAKER, 0n, inside))).toBe("update cooldown");
    expect(await agree(update(150n * USD, ACTOR_TAKER, 10n * USD, inside))).toBe("update cooldown");
  }, 60_000);

  it("accepts a below-IM taker add that reaches IM inside the cooldown, refuses a smaller one", async () => {
    expect(await agree(update(80n * USD, ACTOR_TAKER, 20n * USD, inside))).toBeNull();
    expect(await agree(update(80n * USD, ACTOR_TAKER, 20n * USD - 1n, inside))).toBe("cure must reach initial margin");
  }, 60_000);

  it("accepts a taker add that cures maintenance; after the cooldown a partial top-up is an ordinary add", async () => {
    // Liquidatable at 40: inside the cooldown the cure must reach 100; after it, 60 (above maintenance) is enough.
    expect(await agree(update(40n * USD, ACTOR_TAKER, 60n * USD, inside))).toBeNull();
    expect(await agree(update(40n * USD, ACTOR_TAKER, 20n * USD, after))).toBeNull();
    expect(await agree(update(40n * USD, ACTOR_TAKER, 5n * USD, after))).toBe("update leaves pair liquidatable");
  }, 60_000);

  it("stamps the next version and reports when it can next change", async () => {
    const w = update(150n * USD, ACTOR_TAKER, 10n * USD, after);
    expect([w.record.updatedAt, nextUpdateAt(w.record, GAP), w.outcome.refused]).toEqual([after, after + GAP, null]);
  });

  it("takes the relay fee from the actor's out note; actor 0 can only pay zero", async () => {
    // #given a taker add of 20 from a 100 note, paying the relayer 1
    const paid = update(150n * USD, ACTOR_TAKER, 20n * USD, after, { value: USD, to: addressOf(relayer) });
    const keyless = update(150n * USD, ACTOR_NONE, 0n, afterGrace);
    const forced = structuredClone(keyless.inputs);
    (forced.relay as { value: string }).value = toHex32(USD);
    // #when / #then
    expect(await agree(paid)).toBeNull();
    expect([paid.outValue, scanFee(relayer, paid.publicInputs.relayFee).map((n) => n.value)]).toEqual([79n * USD, [USD]]);
    await expect(execute("pair_update", forced)).rejects.toThrow("fee needs the owner key");
    expect(() => update(150n * USD, ACTOR_NONE, 0n, afterGrace, { value: USD, to: addressOf(relayer) })).toThrow("fee needs the owner key");
  }, 60_000);

  it("keeps the clock on a cure, so the cooldown still ends on the replaced version's schedule", async () => {
    const w = update(80n * USD, ACTOR_TAKER, 20n * USD, inside);
    expect(await agree(w)).toBeNull();
    expect(w.record.updatedAt).toBe(OPENED_AT);
  }, 60_000);

  it("lets only the taker update during the grace after each cooldown", async () => {
    expect(await agree(update(150n * USD, ACTOR_MAKER, 10n * USD, after))).toBe("taker grace");
    expect(await agree(update(150n * USD, ACTOR_NONE, 0n, afterGrace - 1n))).toBe("taker grace");
    expect(await agree(update(150n * USD, ACTOR_TAKER, 10n * USD, afterGrace - 1n))).toBeNull();
    expect(await agree(update(150n * USD, ACTOR_MAKER, 10n * USD, afterGrace))).toBeNull();
    expect(await agree(update(150n * USD, ACTOR_NONE, 0n, afterGrace))).toBeNull();
  }, 120_000);
});

describe("updateOutcome", () => {
  const outcome = (takerMargin: bigint, actor: bigint, add: bigint, asOf: bigint, mark = MARK) =>
    updateOutcome(pairWith(takerMargin, 500n * USD), { actor, add, remove: 0n, reduce: 0n }, mark, IMR, SCALE, FUNDING_INDEX_ZERO, 10n, { mmrWad: MMR, asOf, minGap: GAP }).refused;

  it("enforces the cure only inside the cooldown", () => {
    expect([
      outcome(80n * USD, ACTOR_TAKER, 10n * USD, OPENED_AT + GAP - 1n),
      outcome(80n * USD, ACTOR_TAKER, 10n * USD, OPENED_AT + GAP),
      outcome(80n * USD, ACTOR_MAKER, 10n * USD, OPENED_AT + 1n),
      outcome(80n * USD, ACTOR_TAKER, 20n * USD, OPENED_AT + 1n, 0n),
    ]).toEqual(["cure must reach initial margin", null, "update cooldown", "update cooldown"]);
  });

  it("uses the mirrored contract gap by default", () => {
    expect(nextUpdateAt(pairWith(0n, 0n))).toBe(OPENED_AT + 600n);
  });
});

describe("open-interest kinds", () => {
  it("update and close deltas differ when the reduce equals the remaining size (#6)", () => {
    // #given a reduce that leaves 3 units and the later close of that version, under the same nonce
    const size = 3n * WAD;
    // #when / #then
    const reduce = oiDeltaCommitment(DEPLOYMENT, 3n, 0n, size, OI_REDUCE, 99n);
    expect(new Set([reduce, oiDeltaCommitment(DEPLOYMENT, 3n, 0n, size, OI_CLOSE, 99n), oiDeltaCommitment(DEPLOYMENT, 3n, 0n, size, OI_OPEN, 99n)]).size).toBe(3);
  });

  it("funding_epoch folds a reduce of kind 2 and rejects kind 3", async () => {
    // #given an open of 4 and a reduce of 1 on a fresh market
    const state = { longOi: 0n, shortOi: 0n, insurance: 0n, badDebt: 0n, bondUsed: 0n, blind: 0n };
    const deltas = [
      { isShort: 0n, size: 4n * WAD, kind: OI_OPEN, recNonce: 1n },
      { isShort: 0n, size: WAD, kind: OI_REDUCE, recNonce: 2n },
    ].map((opening) => ({ opening, commitment: oiDeltaCommitment(DEPLOYMENT, 3n, opening.isShort, opening.size, opening.kind, opening.recNonce) }));
    const w = fundingEpochWitness({ deployment: DEPLOYMENT, market: 3n, state, head: 0n, deltas, asOf: 1n, dt: 0n, mark: MARK, maxRateWad: 0n, keys: [taker.pk, maker.pk, worker.pk] });
    const bad = structuredClone(w.inputs);
    (bad.deltas as { kind: string }[])[1]!.kind = toHex32(3n);
    (bad.delta_cm as string[])[1] = toHex32(oiDeltaCommitment(DEPLOYMENT, 3n, 0n, WAD, 3n, 2n));
    const lying = structuredClone(w.inputs);
    lying.bond_used_next = toHex32(1n);
    // #when / #then
    await execute("funding_epoch", w.inputs);
    expect([w.next.longOi, w.publicInputs.bondUsedPrev, w.publicInputs.bondUsedNext]).toEqual([3n * WAD, 0n, 0n]);
    await expect(execute("funding_epoch", bad)).rejects.toThrow("unknown kind");
    await expect(execute("funding_epoch", lying)).rejects.toThrow("wrong bond_used_next");
    expect(() => fundingEpochWitness({ deployment: DEPLOYMENT, market: 3n, state, head: 0n, deltas: [{ ...deltas[1]!, opening: { ...deltas[1]!.opening, kind: 3n } }], asOf: 1n, dt: 0n, mark: MARK, maxRateWad: 0n, keys: [taker.pk, maker.pk, worker.pk] })).toThrow("unknown kind");
  }, 60_000);

  it("funding_epoch publishes the bond draw when claims exceed insurance", async () => {
    // #given a claim of 10 against no insurance and a bond of 25, 5 of it already used
    const state = { longOi: 0n, shortOi: 0n, insurance: 0n, badDebt: 0n, bondUsed: 5n * USD, blind: 8n };
    const opening = { isShort: 0n, size: 0n, kind: OI_CLOSE, recNonce: 3n, claim: 10n * USD };
    const deltas = [{ opening, commitment: oiDeltaCommitment(DEPLOYMENT, 3n, 0n, 0n, OI_CLOSE, 3n, 0n, opening.claim) }];
    const w = fundingEpochWitness({ deployment: DEPLOYMENT, market: 3n, state, head: marketHead(DEPLOYMENT, 3n, state), deltas, asOf: 1n, dt: 0n, mark: 0n, maxRateWad: 0n, keys: [taker.pk, maker.pk, worker.pk], bondTotal: 25n * USD });
    // #when / #then
    await execute("funding_epoch", w.inputs);
    expect([w.publicInputs.bondUsedPrev, w.publicInputs.bondUsedNext]).toEqual([5n * USD, 15n * USD]);
  }, 60_000);
});

describe("open_pair close spread cap (#9)", () => {
  function open(closeSpread: bigint) {
    const taker1 = lockAddressKeys(6n, 0);
    const maker1 = lockAddressKeys(7n, 0);
    const lockOf = (k: WalletKeys, terms: LockTerms, amount: bigint, recNonce: bigint): LockRecord => ({
      ...terms, asset: USDG, amount, ownerAuth: k.auth, ownerX: k.pk.x, ownerY: k.pk.y, expiry: OPENED_AT + 600n, recNonce, blind: recNonce + 1n,
    });
    const t = lockOf(taker1, takerTerms(3n, false, 4n * WAD, 300n * WAD), 200n * USD, 71n);
    const m = lockOf(maker1, makerTerms(3n, 10n, 10n * WAD, closeSpread), 300n * USD, 81n);
    const tree = new MerkleTree();
    const heldT = { record: t, leafIndex: tree.insert(lockCommitment(DEPLOYMENT, t)) };
    const heldM = { record: m, leafIndex: tree.insert(lockCommitment(DEPLOYMENT, m)) };
    return openPairWitness({
      taker: heldT, maker: heldM, makerMargin: 200n * USD, deployment: DEPLOYMENT, tree, mark: MARK, asOf: OPENED_AT, imrWad: IMR, scale: SCALE, riskKeys: [maker.pk, worker.pk],
      fundingIndex: FUNDING_INDEX_ZERO,
      limits: {
        feeBps: 10n, feeTo: addressOf(worker), head: 0n, state: { longOi: 0n, shortOi: 0n, insurance: 0n, badDebt: 0n, bondUsed: 0n, blind: 0n }, oiPending: 0n,
        maxOiUsd: 10n ** 30n, maxPairSize: 100n * WAD, maxCloseSpread: 50n,
      },
    });
  }

  it("refuses a maker close spread above the market cap and stamps an accepted pair with as_of", async () => {
    const ok = open(50n);
    await execute("open_pair", ok.inputs);
    await expect(execute("open_pair", open(51n).inputs)).rejects.toThrow("close spread above market cap");
    expect([ok.record.updatedAt, ok.record.closeSpread]).toEqual([OPENED_AT, 50n]);
  }, 60_000);
});

describe("zero relay fee helper", () => {
  it("is a zero value to the given address", () => {
    expect(zeroRelayFee(addressOf(wallet))).toEqual({ value: 0n, to: addressOf(wallet) });
  });
});
