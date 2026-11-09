import { BaseError, ContractFunctionRevertedError, HttpRequestError, RpcRequestError, TimeoutError } from "viem";
import { classifyError, type ApiErrorBody, type ApiRequestReasonCode, type ReasonCode } from "@rooq/sdk";

export type ApiReasonCode = ReasonCode | ApiRequestReasonCode;

/** An error that is safe to show: fixed message, stable reason code, optional structured details. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly reasonCode: ApiReasonCode,
    message: string,
    readonly canRetry: boolean,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class DeadlineError extends Error {
  constructor(readonly ms: number) {
    super(`deadline of ${ms} ms exceeded`);
    this.name = "DeadlineError";
  }
}

export const badRequest = (message: string, details?: unknown): ApiError => new ApiError(400, "INVALID_REQUEST", message, false, details);
export const notFound = (message: string): ApiError => new ApiError(404, "NOT_FOUND", message, false);
export const indexerUnavailable = (): ApiError =>
  new ApiError(503, "INDEXER_BEHIND", "History is unavailable while the indexer database is unreachable.", true);
export const networkDelayed = (message: string): ApiError => new ApiError(503, "NETWORK_DELAYED", message, true);

/** The wire envelope. Every call gets a fresh request id; nothing from the stack or the node leaks. */
export function errorBody(error: ApiError, requestId: string = crypto.randomUUID()): ApiErrorBody {
  return {
    statusCode: error.statusCode,
    reasonCode: error.reasonCode,
    message: error.message,
    canRetry: error.canRetry,
    requestId,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

const NOT_FOUND_REVERTS: Record<string, string> = {
  UnknownMarket: "Unknown market.",
  PoolNotFound: "No Rooq pool for this route.",
};

/** Maps anything thrown while serving a request onto the stable vocabulary. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DeadlineError) return networkDelayed(`The request did not complete within ${error.ms} ms.`);
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      const missing = name ? NOT_FOUND_REVERTS[name] : undefined;
      if (missing) return notFound(missing);
      if (name === "BadPath") return badRequest("A path has 2 or 3 tokens and one fee per hop.");
      const rooq = classifyError(error);
      return new ApiError(422, rooq.reasonCode, "The contract rejected this request.", rooq.canRetry, name ? { errorName: name } : undefined);
    }
    if (error.walk((e) => e instanceof TimeoutError || e instanceof HttpRequestError || e instanceof RpcRequestError)) {
      return networkDelayed("The chain RPC did not answer in time.");
    }
  }
  return new ApiError(500, "INTERNAL", "Internal error.", true);
}
