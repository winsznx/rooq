import {
  AbiEventSignatureNotFoundError,
  DecodeLogDataMismatch,
  DecodeLogTopicsMismatch,
  decodeEventLog,
  type Address,
  type DecodeEventLogReturnType,
  type Hex,
} from "viem";
import {
  clearingHouseAbi,
  marginVaultAbi,
  marketBackstopAbi,
  marketPreflightAbi,
  marketRegistryAbi,
  mockPriceFeedAbi,
  oracleAdapterAbi,
  spotFactoryAbi,
  spotPoolAbi,
} from "@rooq/sdk";

/** Contract roles whose logs are indexed. Router and lens emit nothing and are not watched. */
export const CONTRACT_KINDS = [
  "clearingHouse",
  "marginVault",
  "marketRegistry",
  "marketBackstop",
  "marketPreflight",
  "oracleAdapter",
  "spotFactory",
  "spotPool",
  "priceFeed",
] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

export function isContractKind(value: string): value is ContractKind {
  return (CONTRACT_KINDS as readonly string[]).includes(value);
}

export type DecodedEvent =
  | { readonly contract: "clearingHouse"; readonly event: DecodeEventLogReturnType<typeof clearingHouseAbi> }
  | { readonly contract: "marginVault"; readonly event: DecodeEventLogReturnType<typeof marginVaultAbi> }
  | { readonly contract: "marketRegistry"; readonly event: DecodeEventLogReturnType<typeof marketRegistryAbi> }
  | { readonly contract: "marketBackstop"; readonly event: DecodeEventLogReturnType<typeof marketBackstopAbi> }
  | { readonly contract: "marketPreflight"; readonly event: DecodeEventLogReturnType<typeof marketPreflightAbi> }
  | { readonly contract: "oracleAdapter"; readonly event: DecodeEventLogReturnType<typeof oracleAdapterAbi> }
  | { readonly contract: "spotFactory"; readonly event: DecodeEventLogReturnType<typeof spotFactoryAbi> }
  | { readonly contract: "spotPool"; readonly event: DecodeEventLogReturnType<typeof spotPoolAbi> }
  | { readonly contract: "priceFeed"; readonly event: DecodeEventLogReturnType<typeof mockPriceFeedAbi> };

/** Where a log sits in the chain. Addresses and hashes are lowercase throughout the indexer. */
export interface LogPosition {
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly blockTimestamp: bigint;
  readonly txHash: Hex;
  readonly txIndex: number;
  readonly logIndex: number;
  readonly txFrom: Address | null;
  readonly address: Address;
}

export interface IndexedEvent {
  readonly at: LogPosition;
  readonly decoded: DecodedEvent;
}

function isExpectedDecodeFailure(error: unknown): boolean {
  return (
    error instanceof AbiEventSignatureNotFoundError ||
    error instanceof DecodeLogDataMismatch ||
    error instanceof DecodeLogTopicsMismatch
  );
}

/**
 * Decodes a log with the ABI of the contract role that emitted it. Returns null for events that ABI
 * does not declare or data that does not match it; the raw log is still stored unchanged.
 */
export function decodeLog(kind: ContractKind, topics: readonly Hex[], data: Hex): DecodedEvent | null {
  const [signature, ...rest] = topics;
  if (!signature) return null;
  const t: [Hex, ...Hex[]] = [signature, ...rest];
  try {
    switch (kind) {
      case "clearingHouse":
        return { contract: kind, event: decodeEventLog({ abi: clearingHouseAbi, topics: t, data }) };
      case "marginVault":
        return { contract: kind, event: decodeEventLog({ abi: marginVaultAbi, topics: t, data }) };
      case "marketRegistry":
        return { contract: kind, event: decodeEventLog({ abi: marketRegistryAbi, topics: t, data }) };
      case "marketBackstop":
        return { contract: kind, event: decodeEventLog({ abi: marketBackstopAbi, topics: t, data }) };
      case "marketPreflight":
        return { contract: kind, event: decodeEventLog({ abi: marketPreflightAbi, topics: t, data }) };
      case "oracleAdapter":
        return { contract: kind, event: decodeEventLog({ abi: oracleAdapterAbi, topics: t, data }) };
      case "spotFactory":
        return { contract: kind, event: decodeEventLog({ abi: spotFactoryAbi, topics: t, data }) };
      case "spotPool":
        return { contract: kind, event: decodeEventLog({ abi: spotPoolAbi, topics: t, data }) };
      case "priceFeed":
        return { contract: kind, event: decodeEventLog({ abi: mockPriceFeedAbi, topics: t, data }) };
    }
  } catch (error) {
    if (isExpectedDecodeFailure(error)) return null;
    throw error;
  }
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** JSON-safe copy of decoded args: bigints become decimal strings, addresses and hashes lowercase. */
export function toJson(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return /^0x[0-9a-fA-F]*$/.test(value) ? value.toLowerCase() : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, inner] of Object.entries(value)) out[key] = toJson(inner);
    return out;
  }
  return String(value);
}

/** Lowercase hex (addresses, hashes, ids). Every address and hash the indexer stores goes through this. */
export function lower(value: `0x${string}`): `0x${string}` {
  return `0x${value.slice(2).toLowerCase()}`;
}

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
