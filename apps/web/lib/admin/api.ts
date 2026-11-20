import {
  ADMIN_SLICES,
  type AdminActions,
  type AdminFees,
  type AdminFlows,
  type AdminKinds,
  type AdminMarkets,
  type AdminMoney,
  type AdminOperators,
  type AdminOverview,
  type AdminPeople,
  type AdminServices,
  type AdminSliceName,
  type AdminToken,
  type AdminTraffic,
  type AdminVault,
  type AdminWallets,
} from "@rooq/private-sdk/admin";

/** Same-origin admin data endpoints, one per contract slice. Each proxies GET /v1/admin/<slice> on the analytics service. */
export interface AdminSliceData {
  overview: AdminOverview;
  actions: AdminActions;
  flows: AdminFlows;
  wallets: AdminWallets;
  operators: AdminOperators;
  services: AdminServices;
  markets: AdminMarkets;
  traffic: AdminTraffic;
  money: AdminMoney;
  vault: AdminVault;
  fees: AdminFees;
  people: AdminPeople;
  kinds: AdminKinds;
  token: AdminToken;
}

export function isAdminSlice(value: string): value is AdminSliceName {
  return (ADMIN_SLICES as readonly string[]).includes(value);
}

export function adminDataPath(slice: AdminSliceName): `/admin/api/data/${AdminSliceName}` {
  return `/admin/api/data/${slice}`;
}

export type AdminReason =
  | "UNAUTHORIZED"
  | "FORBIDDEN_ORIGIN"
  | "NOT_ADMIN"
  | "NONCE_EXPIRED"
  | "INVALID_MESSAGE"
  | "INVALID_SIGNATURE"
  | "INVALID_REQUEST"
  | "UNKNOWN_SLICE"
  | "NOT_CONFIGURED"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_ERROR";

/** Error body of every /admin/api route. Mirrors the private services' shape without the request id. */
export interface AdminErrorBody {
  statusCode: number;
  reasonCode: AdminReason;
  message: string;
  canRetry: boolean;
}

/** Body of a successful POST /admin/api/auth/verify. */
export interface AdminSignInResult {
  address: `0x${string}`;
  exp: number;
}
