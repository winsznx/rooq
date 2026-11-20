import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { parseAbi, toEventSelector, type Abi, type Hex } from "viem";
import { REPO_ROOT } from "../../src/lib/config";
import { ANALYTICS_EVENTS } from "../../src/lib/analytics-events";
import { buildSelectorMap, classifyCall, loadProtocolAbi, USER_ACTIONS, WALLET_ACTIONS } from "../../src/lib/analytics-selectors";

const ARTIFACTS = process.env.ARTIFACTS_OUT ?? `${REPO_ROOT}contracts/out`;
const built = existsSync(`${ARTIFACTS}/PrivatePairs.sol/PrivatePairs.json`);

describe("selector map", () => {
  const abi = parseAbi([
    "function shield(address asset, uint256 amount, bytes32 inner)",
    "function processQueue(bytes proof)",
    "function swap(bytes proof)",
    "function root() view returns (bytes32)",
  ]);
  const map = buildSelectorMap(abi);

  test("splits by function, not by sender: swap is user intent even though the coordinator sends it", () => {
    const byName = new Map([...map.values()].map((a) => [a.action, a.category]));
    expect(byName.get("shield")).toBe("user");
    expect(byName.get("swap")).toBe("user");
    expect(byName.get("processQueue")).toBe("maintenance");
  });

  test("leaves out view functions", () => {
    expect([...map.values()].some((a) => a.action === "root")).toBe(false);
  });

  test("classifies calldata by its first four bytes, case-insensitively", () => {
    const [selector] = [...map.entries()].find(([, a]) => a.action === "processQueue")!;
    expect(classifyCall(map, `${selector.toUpperCase().replace("0X", "0x")}deadbeef` as Hex)).toEqual({ selector, action: "processQueue", category: "maintenance" });
  });

  test("an unknown selector or a plain transfer is user intent named unknown", () => {
    expect(classifyCall(map, "0x12345678ff")).toEqual({ selector: "0x12345678", action: "unknown", category: "user" });
    expect(classifyCall(map, "0x")).toEqual({ selector: "0x", action: "unknown", category: "user" });
  });

  test("a function repeated across contract ABIs is mapped once", () => {
    const clash: Abi = [
      { type: "function", name: "a", inputs: [], outputs: [], stateMutability: "nonpayable" },
      { type: "function", name: "a", inputs: [], outputs: [], stateMutability: "nonpayable" },
    ];
    expect(buildSelectorMap(clash).size).toBe(1);
  });
});

describe.skipIf(!built)("selector map against the contract build", () => {
  const abi = built ? loadProtocolAbi(ARTIFACTS) : [];
  const map = buildSelectorMap(abi);

  test("matches the selectors of the M36 deployment", () => {
    // The M36 structs (asOf, relay fee outputs, processQueue count, bond_used) changed most selectors from the first testnet
    // deployment; shield, spend, liquidate, createMarket and sweepInsurance kept theirs.
    const seen: Record<string, [string, string]> = {
      "0xc46c36b3": ["shield", "user"], "0x8ee8ac74": ["spend", "user"], "0x36cd45a1": ["lock", "user"], "0x5ad74466": ["lockPair", "user"], "0xa67bd1a4": ["swap", "user"],
      "0x0a2111ba": ["addLiquidity", "user"], "0x802b00cf": ["createMarket", "user"], "0x14d6b72e": ["closePair", "user"],
      "0x182a9862": ["processQueue", "maintenance"], "0x601bb28c": ["advanceFunding", "maintenance"], "0x28566ef2": ["openPair", "maintenance"],
      "0xe5fe3e12": ["release", "maintenance"], "0xaae230f4": ["liquidate", "maintenance"], "0x0f887d3f": ["sweepInsurance", "maintenance"],
      "0xa75f4906": ["sweepProtocolFees", "maintenance"],
    };
    for (const [selector, [action, category]] of Object.entries(seen)) expect(map.get(selector as Hex)).toEqual({ action, category: category as "user" | "maintenance" });
  });

  test("every user action names a real function", () => {
    const names = new Set([...map.values()].map((a) => a.action));
    for (const action of USER_ACTIONS) expect(names.has(action)).toBe(true);
  });

  test("releaseBond is maintenance: the risk worker sends it, so its sender is never a public wallet", () => {
    expect([...map.values()].find((a) => a.action === "releaseBond")?.category).toBe("maintenance");
    expect(WALLET_ACTIONS.has("releaseBond")).toBe(false);
    for (const action of WALLET_ACTIONS) expect(USER_ACTIONS.has(action)).toBe(true);
  });

  test("every indexed event signature is one the contracts emit", () => {
    const emitted = new Set(abi.filter((i) => i.type === "event").map((i) => toEventSelector(i)));
    for (const event of ANALYTICS_EVENTS) if (event.name !== "AnswerUpdated") expect(emitted.has(toEventSelector(event))).toBe(true);
  });
});
