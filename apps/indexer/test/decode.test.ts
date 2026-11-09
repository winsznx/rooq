import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { clearingHouseAbi, marginVaultAbi, spotPoolAbi } from "@rooq/sdk";
import { decodeLog, toJson } from "../src/decode";
import { eventFacts } from "../src/facts";
import { emptyState } from "../src/state";
import { BASE, COLLATERAL, Clock, MAKER, MARKET, POOL, TAKER, VAULT, ctx } from "./fixtures";

const WAD = 10n ** 18n;

/** encodeEventTopics allows null/OR-array entries for filters; a concrete log only has single topics. */
function concrete(topics: readonly (Hex | Hex[] | null)[]): Hex[] {
  return topics.map((t) => {
    if (typeof t !== "string") throw new Error("fixture topic must be a single value");
    return t;
  });
}

function tradeExecutedLog(): { topics: Hex[]; data: Hex } {
  const topics = concrete(encodeEventTopics({ abi: clearingHouseAbi, eventName: "TradeExecuted", args: { marketId: MARKET, taker: TAKER, maker: MAKER } }));
  const data = encodeAbiParameters(
    [{ type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "int256" }, { type: "bytes32" }],
    [-2n * WAD, 359n * WAD, 360n * WAD, 1_234n, -7n, `0x${"ab".repeat(32)}`],
  );
  return { topics, data };
}

describe("decodeLog", () => {
  test("decodes a ClearingHouse log into typed args", () => {
    // #given an encoded TradeExecuted log
    const { topics, data } = tradeExecutedLog();
    // #when decoded with the ClearingHouse role
    const decoded = decodeLog("clearingHouse", topics, data);
    // #then the signed size and price round-trip exactly
    expect(decoded?.event.eventName === "TradeExecuted" ? [decoded.event.args.sizeDelta, decoded.event.args.price, decoded.event.args.realizedPnl] : null).toEqual([
      -2n * WAD,
      359n * WAD,
      -7n,
    ]);
  });

  test("returns null for a log the role's ABI does not declare", () => {
    // #given a ClearingHouse log read as if it came from the vault
    const { topics, data } = tradeExecutedLog();
    // #when / #then the raw row is kept but not decoded
    expect(decodeLog("marginVault", topics, data)).toBeNull();
  });

  test("returns null for a log without topics", () => {
    expect(decodeLog("clearingHouse", [], "0x")).toBeNull();
  });
});

describe("toJson", () => {
  test("turns bigints into decimal strings and lowercases hex", () => {
    expect(toJson({ amount: -5n, who: "0xAbC", nested: [1n, { ok: true }] })).toEqual({ amount: "-5", who: "0xabc", nested: ["1", { ok: true }] });
  });
});

describe("eventFacts", () => {
  test("attributes a deposit to the payer and the credited account, not to an unrelated sender", () => {
    // #given a deposit paid by the maker for the taker, relayed by a third address
    const relayer: Address = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
    const at = new Clock().next(VAULT, { txFrom: relayer });
    const topics = concrete(encodeEventTopics({ abi: marginVaultAbi, eventName: "Deposited", args: { payer: MAKER, account: TAKER } }));
    const decoded = decodeLog("marginVault", topics, encodeAbiParameters([{ type: "uint256" }], [5n]));
    if (!decoded) throw new Error("fixture did not decode");
    // #when
    const facts = eventFacts(decoded, at, emptyState(), ctx);
    // #then
    expect([facts.actors, facts.streamType, facts.marketId]).toEqual([[MAKER, TAKER].sort(), null, null]);
  });

  test("attributes a router swap to the transaction sender as well as the pool's sender and recipient", () => {
    // #given a swap whose pool-level sender is the router
    const router: Address = "0xdc64a140aa3e981100a9beca4e685f962f0cf6c9";
    const at = new Clock().next(POOL, { txFrom: TAKER });
    const topics = concrete(encodeEventTopics({ abi: spotPoolAbi, eventName: "SwapExecuted", args: { sender: router, recipient: router } }));
    const data = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [COLLATERAL, BASE, 1n, 1n, 0n],
    );
    const decoded = decodeLog("spotPool", topics, data);
    if (!decoded) throw new Error("fixture did not decode");
    // #when
    const facts = eventFacts(decoded, at, emptyState(), ctx);
    // #then the trader who signed the transaction sees it
    expect([facts.actors, facts.streamType]).toEqual([[router, TAKER].sort(), "pool.swap"]);
  });

  test("streams perp fills under their market", () => {
    // #given a TradeExecuted log
    const { topics, data } = tradeExecutedLog();
    const decoded = decodeLog("clearingHouse", topics, data);
    if (!decoded) throw new Error("fixture did not decode");
    // #when
    const facts = eventFacts(decoded, new Clock().next(VAULT), emptyState(), ctx);
    // #then
    expect([facts.streamType, facts.marketId]).toEqual(["perp.trade", MARKET]);
  });
});
