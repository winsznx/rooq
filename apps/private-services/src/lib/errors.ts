import { BaseError, ContractFunctionRevertedError, HttpRequestError, RpcRequestError, TimeoutError } from "viem";

/** Stable vocabulary a wallet UI can switch on. Contract reverts map onto it in `reasonForRevert`. */
export type Reason =
  | "INVALID_REQUEST" | "INVALID_JSON" | "BODY_TOO_LARGE" | "UNKNOWN_ACTION" | "NOT_FOUND" | "METHOD_NOT_ALLOWED" | "RATE_LIMITED" | "JOB_UNKNOWN"
  | "QUEUE_FULL" | "NOT_READY" | "INSUFFICIENT_GAS" | "NULLIFIER_IN_FLIGHT" | "RPC_UNAVAILABLE" | "TX_TIMEOUT" | "REORGED" | "REVERTED_UNKNOWN" | "INTERNAL"
  | "UNKNOWN_ROOT" | "NULLIFIER_SPENT" | "INVALID_PROOF" | "NOT_A_FIELD_ELEMENT" | "UNKNOWN_MARKET" | "STALE_AS_OF" | "FUNDING_STALE" | "BAD_BOND"
  | "EXIT_ALREADY_REQUESTED" | "EXIT_NOT_MATURE" | "ORACLE_UNAVAILABLE" | "ORACLE_NOT_DEAD" | "CLAIM_NOT_FOLDED" | "PAIR_STILL_LIVE" | "NO_BOND" | "TREE_FULL" | "NOTHING_QUEUED"
  | "MARKET_NOT_WOUND_DOWN" | "UNSUPPORTED_ASSET" | "BAD_AMOUNT" | "UNKNOWN_POOL"
  | "RELAYER_FEE_REQUIRED" | "RELAYER_FEE_ASSET" | "RELAYER_FEE_TOO_LOW" | "QUOTE_UNAVAILABLE" | "POOL_EMPTY" | "ASSET_NOT_IN_POOL"
  | "MARKET_CLOSE_ONLY" | "BOND_ALREADY_RELEASED" | "MARKET_STILL_OPEN" | "EXIT_NOT_CARRIED";

export class ServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly reasonCode: Reason,
    message: string,
    readonly canRetry: boolean,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export const badRequest = (message: string, reason: Reason = "INVALID_REQUEST"): ServiceError => new ServiceError(400, reason, message, false);

const REVERT_REASONS: Record<string, Reason> = {
  UnknownRoot: "UNKNOWN_ROOT",
  NullifierSpent: "NULLIFIER_SPENT",
  InvalidProof: "INVALID_PROOF",
  NotAFieldElement: "NOT_A_FIELD_ELEMENT",
  UnknownMarket: "UNKNOWN_MARKET",
  StaleAsOf: "STALE_AS_OF",
  FundingStale: "FUNDING_STALE",
  BadBond: "BAD_BOND",
  ExitAlreadyRequested: "EXIT_ALREADY_REQUESTED",
  ExitNotMature: "EXIT_NOT_MATURE",
  OracleUnavailable: "ORACLE_UNAVAILABLE",
  PriceStale: "ORACLE_UNAVAILABLE",
  PriceInvalid: "ORACLE_UNAVAILABLE",
  FeedNotApproved: "ORACLE_UNAVAILABLE",
  OracleNotDead: "ORACLE_NOT_DEAD",
  ClaimNotFolded: "CLAIM_NOT_FOLDED",
  PairStillLive: "PAIR_STILL_LIVE",
  NoBond: "NO_BOND",
  TreeFull: "TREE_FULL",
  NothingQueued: "NOTHING_QUEUED",
  MarketNotWoundDown: "MARKET_NOT_WOUND_DOWN",
  UnsupportedAsset: "UNSUPPORTED_ASSET",
  BadAmount: "BAD_AMOUNT",
  UnknownPool: "UNKNOWN_POOL",
  MarketCloseOnly: "MARKET_CLOSE_ONLY",
  BondAlreadyReleased: "BOND_ALREADY_RELEASED",
  MarketStillOpen: "MARKET_STILL_OPEN",
  ExitNotCarried: "EXIT_NOT_CARRIED",
  ProofLengthWrong: "INVALID_PROOF",
  ProofLengthWrongWithLogN: "INVALID_PROOF",
  PublicInputsLengthWrong: "INVALID_PROOF",
  SumcheckFailed: "INVALID_PROOF",
  ShpleminiFailed: "INVALID_PROOF",
  ConsistencyCheckFailed: "INVALID_PROOF",
  GeminiChallengeInSubgroup: "INVALID_PROOF",
  ValueGeFieldOrder: "INVALID_PROOF",
  ValueGeGroupOrder: "INVALID_PROOF",
  ValueGeLimbMax: "INVALID_PROOF",
  PointAtInfinity: "INVALID_PROOF",
  InvertOfZero: "INVALID_PROOF",
  NotPowerOfTwo: "INVALID_PROOF",
};

export interface RevertInfo {
  readonly reason: Reason;
  /** Contract error name when one was decoded. */
  readonly name: string | null;
}

export function revertFromName(name: string | null): RevertInfo {
  return { reason: (name && REVERT_REASONS[name]) || "REVERTED_UNKNOWN", name };
}

/** Anything that is not a decoded contract revert becomes RPC_UNAVAILABLE or a rethrown error. */
export function decodeRevert(error: unknown): RevertInfo | null {
  if (!(error instanceof BaseError)) return null;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError) return revertFromName(revert.data?.errorName ?? null);
  return null;
}

export function isRpcFailure(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return error.walk((e) => e instanceof TimeoutError || e instanceof HttpRequestError || e instanceof RpcRequestError) !== null;
}

export function toServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (isRpcFailure(error)) return new ServiceError(503, "RPC_UNAVAILABLE", "The chain RPC did not answer in time.", true);
  return new ServiceError(500, "INTERNAL", "Internal error.", true);
}

export function errorBody(error: ServiceError, requestId: string): Record<string, unknown> {
  return {
    statusCode: error.statusCode,
    reasonCode: error.reasonCode,
    message: error.message,
    canRetry: error.canRetry,
    requestId,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}
