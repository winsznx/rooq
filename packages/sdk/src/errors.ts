import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, decodeErrorResult, type Abi, type Hex } from "viem";
import {
  clearingHouseAbi,
  marginVaultAbi,
  marketBackstopAbi,
  marketPreflightAbi,
  marketRegistryAbi,
  oracleAdapterAbi,
  spotPoolAbi,
  spotRouterAbi,
} from "./abi";

/** Stable reason codes from 03-ENGINEERING/API_AND_EVENTS.md. */
export type ReasonCode =
  | "CHAIN_MISMATCH"
  | "PRICE_STALE"
  | "QUOTE_EXPIRED"
  | "MARKET_CLOSE_ONLY"
  | "MARKET_PAUSED"
  | "MAKER_CAPACITY_EXHAUSTED"
  | "MARGIN_TOO_LOW"
  | "BAD_SIGNATURE"
  | "NONCE_USED"
  | "MAX_OI"
  | "COLLATERAL_UNSUPPORTED"
  | "MIN_OUTPUT"
  | "NETWORK_DELAYED"
  | "CANNOT_WITHDRAW_LOCKED"
  | "INDEXER_BEHIND"
  | "TX_REORGED"
  | "FORBIDDEN_REGION"
  | "USER_REJECTED"
  | "INSUFFICIENT_BALANCE"
  | "PRICE_DEVIATION"
  | "INTERNAL";

export interface RooqError {
  readonly reasonCode: ReasonCode;
  /** Key into 02-UX/copy.json `errors` (or `perps`) for the exact user-facing sentence. */
  readonly copyKey: string;
  readonly canRetry: boolean;
  /** Decoded contract error name, when the chain returned one. */
  readonly errorName?: string;
  readonly args?: readonly unknown[];
}

const ABIS: readonly Abi[] = [
  clearingHouseAbi,
  marginVaultAbi,
  marketBackstopAbi,
  marketPreflightAbi,
  marketRegistryAbi,
  oracleAdapterAbi,
  spotPoolAbi,
  spotRouterAbi,
];

const BY_ERROR: Record<string, Omit<RooqError, "errorName" | "args">> = {
  PriceStale: { reasonCode: "PRICE_STALE", copyKey: "errors.oracleStale", canRetry: true },
  PriceInvalid: { reasonCode: "PRICE_STALE", copyKey: "errors.oracleStale", canRetry: true },
  FeedNotApproved: { reasonCode: "PRICE_STALE", copyKey: "preflight.sourceMissing", canRetry: false },
  QuoteExpired: { reasonCode: "QUOTE_EXPIRED", copyKey: "errors.quoteExpired", canRetry: true },
  TradeExpired: { reasonCode: "QUOTE_EXPIRED", copyKey: "errors.quoteExpired", canRetry: true },
  MarketNotOpen: { reasonCode: "MARKET_CLOSE_ONLY", copyKey: "errors.paused", canRetry: false },
  MakerCapacityExhausted: { reasonCode: "MAKER_CAPACITY_EXHAUSTED", copyKey: "perps.noLiquidity", canRetry: true },
  MarginTooLow: { reasonCode: "MARGIN_TOO_LOW", copyKey: "errors.insufficientMargin", canRetry: true },
  BadSignature: { reasonCode: "BAD_SIGNATURE", copyKey: "errors.quoteExpired", canRetry: true },
  NonceUsed: { reasonCode: "NONCE_USED", copyKey: "errors.quoteExpired", canRetry: true },
  OverFill: { reasonCode: "NONCE_USED", copyKey: "errors.quoteExpired", canRetry: true },
  MaxOpenInterest: { reasonCode: "MAX_OI", copyKey: "errors.marketFull", canRetry: false },
  CollateralUnsupported: { reasonCode: "COLLATERAL_UNSUPPORTED", copyKey: "errors.generic", canRetry: false },
  InsufficientOutput: { reasonCode: "MIN_OUTPUT", copyKey: "errors.quoteExpired", canRetry: true },
  SlippageExceeded: { reasonCode: "MIN_OUTPUT", copyKey: "errors.quoteExpired", canRetry: true },
  InsufficientBalance: { reasonCode: "CANNOT_WITHDRAW_LOCKED", copyKey: "errors.insufficientBalance", canRetry: false },
  BackingBelowMinimum: { reasonCode: "CANNOT_WITHDRAW_LOCKED", copyKey: "errors.generic", canRetry: false },
  BondLocked: { reasonCode: "CANNOT_WITHDRAW_LOCKED", copyKey: "errors.generic", canRetry: false },
  PriceDeviation: { reasonCode: "PRICE_DEVIATION", copyKey: "errors.oracleConflict", canRetry: true },
  LimitPriceExceeded: { reasonCode: "PRICE_DEVIATION", copyKey: "errors.quoteExpired", canRetry: true },
  PoolIsPaused: { reasonCode: "MARKET_PAUSED", copyKey: "errors.paused", canRetry: false },
  StaleReduceMustClose: { reasonCode: "PRICE_STALE", copyKey: "errors.staleReduce", canRetry: true },
};

export function decodeContractError(data: Hex): RooqError | null {
  for (const abi of ABIS) {
    try {
      const decoded = decodeErrorResult({ abi, data });
      const mapped = BY_ERROR[decoded.errorName] ?? { reasonCode: "INTERNAL", copyKey: "errors.generic", canRetry: false };
      return { ...mapped, errorName: decoded.errorName, args: decoded.args };
    } catch {
      // Not an error from this ABI; try the next one. Falls through to null when none match.
      continue;
    }
  }
  return null;
}

/** Classifies anything thrown by viem/wagmi into the stable vocabulary. Never leaks raw messages to UI copy. */
export function classifyError(error: unknown): RooqError {
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) {
      return { reasonCode: "USER_REJECTED", copyKey: "errors.signatureRejected", canRetry: true };
    }
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      if (name) {
        const mapped = BY_ERROR[name] ?? { reasonCode: "INTERNAL" as const, copyKey: "errors.generic", canRetry: false };
        return { ...mapped, errorName: name, args: revert.data?.args };
      }
      if (revert.raw) {
        const decoded = decodeContractError(revert.raw);
        if (decoded) return decoded;
      }
    }
    if (/chain/i.test(error.shortMessage) && /mismatch|does not match/i.test(error.shortMessage)) {
      return { reasonCode: "CHAIN_MISMATCH", copyKey: "errors.wrongNetwork", canRetry: true };
    }
    if (/timed out|timeout|fetch failed|network/i.test(error.shortMessage)) {
      return { reasonCode: "NETWORK_DELAYED", copyKey: "errors.generic", canRetry: true };
    }
  }
  return { reasonCode: "INTERNAL", copyKey: "errors.generic", canRetry: true };
}
