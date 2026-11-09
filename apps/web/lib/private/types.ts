import type { Hex } from "viem";
import type { OperationKind, OperationStage, OperationStep } from "@/lib/operations";

/** Everything here crosses from the wallet worker to the page. No spending key, viewing key or seed appears in any of it. */

/** `no_wallet`: nothing connected. `sign`: this wallet needs to sign. `unlock`: remembered here, passkey or device key opens it. */
export type VaultStatus = "checking" | "no_wallet" | "sign" | "unlock" | "unlocked";

export interface RememberedInfo {
  readonly method: "passkey" | "device";
  readonly credentialId: string | null;
}

export type AccountSource = "signature" | "passkey" | "remembered";

export interface MarketView {
  readonly id: bigint;
  readonly label: string;
  readonly collateral: Hex;
  readonly feedId: Hex;
  readonly mark: bigint | null;
  readonly markFresh: boolean;
  readonly markAgeSeconds: number | null;
  readonly imrWad: bigint;
  readonly mmrWad: bigint;
  readonly penaltyBps: bigint;
  readonly scale: bigint;
  readonly takerFeeBps: bigint;
  readonly maxPairSize: bigint;
  readonly maxOiUsdWad: bigint;
  readonly maxFundingPerHourWad: bigint;
  readonly fundingIndex: bigint;
  readonly fundingLastEpoch: bigint;
  readonly fundingEpochs: number;
  /** Per second, signed: positive means longs pay. Null until a funding epoch has run. */
  readonly fundingPerSecondWad: bigint | null;
  readonly history: readonly PricePoint[];
}

export interface PricePoint {
  readonly time: number;
  readonly price: number;
}

export interface TokenInfo {
  readonly address: Hex;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

export interface TierView {
  readonly id: number;
  readonly imrWad: bigint;
  readonly mmrWad: bigint;
  readonly maxOiUsdWad: bigint;
  readonly takerFeeBps: bigint;
  readonly penaltyBps: bigint;
  readonly maxFundingPerHourWad: bigint;
  readonly maxPairSize: bigint;
  readonly minBond: bigint;
}

export interface CreateInfo {
  readonly module: Hex;
  readonly collateral: Hex;
  readonly tiers: readonly TierView[];
  readonly feeds: readonly { readonly id: Hex; readonly label: string; readonly approved: boolean; readonly taken: boolean }[];
}

export interface PoolView {
  readonly id: bigint;
  readonly token0: Hex;
  readonly token1: Hex;
  readonly feeBps: bigint;
  readonly seeded: boolean;
}

export interface BalanceView {
  readonly asset: Hex;
  /** Spendable now: unspent notes already in the tree. */
  readonly free: bigint;
  /** Notes created but not yet in the tree. */
  readonly arriving: bigint;
  /** Largest amount one proof can move (two notes of one address). */
  readonly largestSpendable: bigint;
  readonly noteCount: number;
}

export type LockRole = "taker" | "maker" | "swap" | "lp";

export type LockStatus = "queued" | "live" | "expired" | "matched" | "released";

export interface LockView {
  readonly id: Hex;
  readonly role: LockRole;
  readonly status: LockStatus;
  readonly asset: Hex;
  readonly amount: bigint;
  readonly expiry: bigint;
  readonly market: bigint;
  /** Role terms: taker side/size/limit, maker spread/max size/close spread, swap second pool/min out, LP side/min shares. */
  readonly isShort: boolean;
  readonly size: bigint;
  readonly limit: bigint;
  readonly spreadBps: bigint;
  readonly closeSpreadBps: bigint;
  readonly secondPool: bigint;
  readonly minOut: bigint;
}

export interface FundingEntry {
  readonly version: number;
  readonly takerPays: boolean;
  readonly owed: bigint;
  readonly paid: bigint;
  readonly shortfall: bigint;
}

export type PositionStatus = "open" | "closed" | "liquidated" | "forced";

export interface PositionView {
  readonly id: string;
  readonly side: "taker" | "maker";
  readonly status: PositionStatus;
  readonly market: bigint;
  readonly asset: Hex;
  readonly isShort: boolean;
  readonly size: bigint;
  readonly entry: bigint;
  readonly closeSpreadBps: bigint;
  readonly fundingIndex: bigint;
  readonly takerMargin: bigint;
  readonly makerMargin: bigint;
  /** Unpaid funding carried on the pair, and which side owes it. */
  readonly fundingDebt: bigint;
  readonly debtByTaker: boolean;
  readonly versions: number;
  readonly funding: readonly FundingEntry[];
  readonly exitMatureAt: bigint | null;
  readonly outcome: { readonly payout: bigint | null; readonly mark: bigint | null; readonly mode: bigint | null; readonly block: bigint | null } | null;
}

export type ClaimStatus = "waiting" | "redeemable" | "redeemed" | "none";

export interface ClaimView {
  readonly id: Hex;
  readonly market: bigint;
  readonly asset: Hex;
  readonly amount: bigint;
  readonly status: ClaimStatus;
  readonly ratio: bigint | null;
}

export type LpStatus = "idle" | "removing" | "request_expired" | "removed";

export interface LpView {
  readonly id: Hex;
  readonly pool: bigint;
  readonly shares: bigint;
  readonly status: LpStatus;
  readonly expiry: bigint;
  readonly min0: bigint;
  readonly min1: bigint;
}

export type ActivityKind = "shield" | "unshield" | "transfer_in" | "open" | "update" | "close" | "liquidated" | "forced" | "swap" | "refund" | "lp_add" | "lp_remove" | "claim";

export interface ActivityEntry {
  readonly id: string;
  readonly icons: readonly OpIcon[];
  readonly kind: ActivityKind;
  readonly title: string;
  readonly detail: string;
  readonly block: bigint | null;
  readonly tx: Hex | null;
  readonly fields: readonly { readonly label: string; readonly value: string }[];
}

export interface SyncInfo {
  readonly syncedBlock: bigint | null;
  readonly head: bigint | null;
  readonly processed: number;
  readonly queueLength: number;
  readonly root: Hex | null;
  readonly updatedAt: number;
  readonly error: string | null;
}

export interface ServiceHealth {
  readonly readApi: boolean;
  readonly relayer: boolean;
  readonly rpc: boolean;
}

export interface PrivateView {
  /** False when this view holds only public data: no account is open. Private fields are then empty, never zero balances to show. */
  readonly unlocked: boolean;
  readonly sync: SyncInfo;
  readonly chainNow: bigint | null;
  readonly health: ServiceHealth;
  readonly tokens: readonly TokenInfo[];
  readonly markets: readonly MarketView[];
  readonly pools: readonly PoolView[];
  readonly create: CreateInfo | null;
  readonly exitBond: bigint;
  readonly pool: Hex;
  readonly relayerFee: readonly { readonly asset: Hex; readonly amount: bigint }[];
  readonly address: string;
  readonly balances: readonly BalanceView[];
  readonly locks: readonly LockView[];
  readonly positions: readonly PositionView[];
  readonly claims: readonly ClaimView[];
  readonly lp: readonly LpView[];
  readonly activity: readonly ActivityEntry[];
}

export interface OpIcon {
  readonly asset?: Hex;
  readonly market?: bigint;
}

export interface PrivateOp {
  readonly id: string;
  readonly icons: readonly OpIcon[];
  readonly kind: OperationKind;
  readonly title: string;
  readonly href: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly stage: OperationStage;
  readonly steps: readonly OperationStep[];
  readonly quoteExpiresAt: number | null;
  readonly finalityNote: string | null;
  readonly message: string | null;
  readonly reason: string | null;
  readonly canRetry: boolean;
  readonly canCancel: boolean;
  readonly dismissed: boolean;
  /** Set when the connected wallet must send the prepared call. Only the explicit emergency unshield uses this. */
  readonly walletCall: { readonly functionName: "spend"; readonly proof: Hex; readonly publicInputs: unknown } | null;
  /** An unshield the relayer couldn't take: the person may choose to pay gas from their own wallet. */
  readonly offerDirect: boolean;
}

export type Intent =
  | { t: "unshield"; asset: Hex; amount: bigint; recipient: Hex; fee: bigint; direct?: boolean }
  | { t: "transfer"; asset: Hex; amount: bigint; to: string; fee: bigint }
  | { t: "combine"; asset: Hex }
  | { t: "perpOpen"; market: bigint; isShort: boolean; size: bigint; margin: bigint; limit: bigint; expiry: bigint }
  | { t: "makerLock"; market: bigint; spreadBps: bigint; maxSize: bigint; closeSpreadBps: bigint; amount: bigint; expiry: bigint }
  | { t: "release"; lock: Hex }
  | { t: "swap"; pool: bigint; secondPool: bigint; assetIn: Hex; amountIn: bigint; minOut: bigint; expiry: bigint; estimatedOut: bigint }
  | { t: "lpAdd"; pool: bigint; amount0: bigint; amount1: bigint; minShares: bigint; expiry: bigint }
  | { t: "lpRequest"; claim: Hex; min0: bigint; min1: bigint; expiry: bigint }
  | { t: "lpRecover"; claim: Hex }
  | { t: "update"; position: string; add: bigint; remove: bigint; reduce: bigint }
  | { t: "close"; position: string }
  | { t: "exit"; position: string }
  | { t: "redeem"; claim: Hex };

export interface StartOp {
  readonly intent: Intent;
  readonly title: string;
  readonly href: string;
}

export interface PrepareShield {
  readonly inner: Hex;
  readonly depositIndex: number;
}

export type WorkerRequest =
  | { m: "wallet"; address: string | null }
  | { m: "signature"; address: string; signature: Hex }
  | { m: "signatures"; address: string; first: Hex; second: Hex }
  | { m: "prfSeed"; address: string; output: Uint8Array }
  | { m: "unlockRemembered"; address: string; output: Uint8Array | null }
  | { m: "rememberPasskey"; output: Uint8Array; credentialId: string }
  | { m: "rememberDevice" }
  | { m: "forgetRemembered" }
  | { m: "lock" }
  | { m: "prepareShield"; asset: Hex; amount: bigint }
  | { m: "shieldFinished"; depositIndex: number; ok: boolean }
  | { m: "start"; op: StartOp }
  | { m: "retryOp"; id: string }
  | { m: "readMark"; market: bigint }
  | { m: "cancelOp"; id: string }
  | { m: "directOp"; id: string }
  | { m: "walletTxSent"; id: string; hash: Hex }
  | { m: "walletTxFailed"; id: string; reason: string; message: string }
  | { m: "dismissOp"; id: string }
  | { m: "syncNow" };

export type WorkerEvent =
  | { e: "status"; status: VaultStatus; remembered: RememberedInfo | null; source: AccountSource | null; verified: boolean }
  | { e: "view"; view: PrivateView }
  | { e: "ops"; ops: readonly PrivateOp[] }
  | { e: "offline"; code: string };
