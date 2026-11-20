import type { AdminRange } from "@rooq/private-sdk/admin";
import { DEFAULT_NETWORK, type AdminNetwork } from "@/lib/admin/hooks";

/** Admin links carry the range and, off the default, the network, so moving between sections keeps the view. */
export function adminHref(path: string, range: AdminRange, network: AdminNetwork): string {
  const query = new URLSearchParams({ range });
  if (network !== DEFAULT_NETWORK) query.set("env", network);
  return `${path}?${query.toString()}`;
}
