import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from "viem";

/** MarginVault ledger domains, reproduced from ClearingHouse and MarketBackstop. All lowercase. */
export const FREE_DOMAIN: Hex = `0x${"0".repeat(64)}`;
export const FEES_DOMAIN: Hex = keccak256(stringToHex("ROOQ_FEES"));

function tagged(tag: string, marketId: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], [tag, marketId]));
}

export function pairDomain(marketId: Hex, taker: Address): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "address" }], ["ROOQ_PAIR", marketId, taker]),
  );
}

export function commitDomain(marketId: Hex): Hex {
  return tagged("ROOQ_COMMIT", marketId);
}

export function backstopDomain(marketId: Hex): Hex {
  return tagged("ROOQ_BACKSTOP", marketId);
}
