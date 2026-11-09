import copyJson from "./copy.json";

/** Canonical interface strings from 02-UX/copy.json. Never inline user-facing copy that exists here. */
export const copy = copyJson;
export type Copy = typeof copyJson;

/** Resolves "section.key" paths such as RooqError.copyKey values. */
/** Strings the spec deck does not cover, kept in one place with the same voice rules. */
const EXTRA: Record<string, string> = {
  "activity.unconfirmed": "Submitted, but no receipt arrived in time. Check the transaction link before you try again.",
  "spot.poolPaused": "Swaps on this pool are paused. Removing liquidity still works.",
  "errors.staleReduce": "Price updates are delayed. You can close the whole position now, or reduce it once prices update.",
};

export function copyAt(path: string): string {
  if (EXTRA[path]) return EXTRA[path];
  const [section, key] = path.split(".");
  const group = section ? (copyJson as Record<string, Record<string, string>>)[section] : undefined;
  return (key && group?.[key]) ?? copyJson.errors.generic;
}
