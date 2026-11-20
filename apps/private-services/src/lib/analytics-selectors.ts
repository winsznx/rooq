import { readFileSync } from "node:fs";
import type { TxCategory } from "@rooq/private-sdk/admin";
import { toFunctionSelector, type Abi, type Hex } from "viem";
import { REPO_ROOT } from "./config";

const PROTOCOL_ARTIFACTS = ["PrivatePairs", "PrivateSpot", "PrivateMarkets"] as const;

/**
 * Functions a user asks for. Most reach the chain through the relayer, coordinator or a risk worker, so a transaction is
 * classified by what it calls, never by who sent it. Every other protocol function is maintenance.
 */
export const USER_ACTIONS: ReadonlySet<string> = new Set([
  "shield", "spend", "lock", "lockPair", "swap", "addLiquidity", "removeLiquidity", "setLiquidityRequest", "closePair", "updatePair", "requestExit",
  "createMarket", "redeemClaim", "closeToNewPositions",
]);

/**
 * Functions a user's own wallet sends (the app's shield and market forms, and a direct spend while the relayer is down).
 * Their sender counts as a public wallet; everything else is sent by our services on a user's behalf. releaseBond is
 * not one: the risk worker submits it and the bond goes to the creator, who is counted from BondReleased instead.
 */
export const WALLET_ACTIONS: ReadonlySet<string> = new Set(["shield", "spend", "createMarket", "closeToNewPositions"]);

export type IndexedCategory = Exclude<TxCategory, "oracle">;

export interface ActionInfo {
  readonly action: string;
  readonly category: IndexedCategory;
}

export interface ClassifiedCall extends ActionInfo {
  readonly selector: Hex;
}

/** A call outside the protocol ABI reached the contracts through another contract, such as a smart wallet, so it is user intent. */
export const UNKNOWN_ACTION: ActionInfo = { action: "unknown", category: "user" };

/** Full ABIs of the three protocol contracts, so the selector map covers functions the services never call. */
export function loadProtocolAbi(out = process.env.ARTIFACTS_OUT ?? `${REPO_ROOT}contracts/out`): Abi {
  return PROTOCOL_ARTIFACTS.flatMap((name) => (JSON.parse(readFileSync(`${out}/${name}.sol/${name}.json`, "utf8")) as { abi: Abi }).abi);
}

/** Derived from the ABI at startup, so a contract change cannot leave a stale hand-kept table behind. */
export function buildSelectorMap(abi: Abi): ReadonlyMap<Hex, ActionInfo> {
  const map = new Map<Hex, ActionInfo>();
  for (const item of abi) {
    if (item.type !== "function" || item.stateMutability === "view" || item.stateMutability === "pure") continue;
    const selector = toFunctionSelector(item);
    const existing = map.get(selector);
    if (existing && existing.action !== item.name) throw new Error(`Selector ${selector} is both ${existing.action} and ${item.name}`);
    map.set(selector, { action: item.name, category: USER_ACTIONS.has(item.name) ? "user" : "maintenance" });
  }
  return map;
}

export function classifyCall(map: ReadonlyMap<Hex, ActionInfo>, input: Hex): ClassifiedCall {
  const selector = (input.length >= 10 ? input.slice(0, 10).toLowerCase() : "0x") as Hex;
  return { selector, ...(map.get(selector) ?? UNKNOWN_ACTION) };
}
