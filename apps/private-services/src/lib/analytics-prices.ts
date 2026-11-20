import { hourOf, type HourlyPrice } from "./analytics-store";

/** An oracle answer with its own decimals: `answer / 10^decimals` dollars per whole token. */
export interface Price {
  readonly answer: bigint;
  readonly decimals: number;
}

/** A Stock Token and the testnet feed that prices it. */
export interface PricedFeed {
  readonly asset: string;
  readonly feed: string;
  readonly decimals: number;
}

export const ONE_DOLLAR: Price = { answer: 1n, decimals: 0 };

/** Dollars kept as an integer of this many decimals before the one conversion to a number. */
const USD_DECIMALS = 6;

/**
 * Dollar value of `amount` base units. Exact in bigint down to a millionth of a dollar, so amounts past 2^53 base units
 * lose nothing before the final conversion. A non-positive answer is not a price.
 */
export function usdValue(amount: bigint, tokenDecimals: number, price: Price): number | null {
  if (price.answer <= 0n) return null;
  const scale = tokenDecimals + price.decimals - USD_DECIMALS;
  const micros = scale >= 0 ? (amount * price.answer) / 10n ** BigInt(scale) : amount * price.answer * 10n ** BigInt(-scale);
  return Number(micros) / 10 ** USD_DECIMALS;
}

/** Rounds to cents for output, so float noise from summing never reaches the page. */
export const cents = (usd: number): number => Math.round(usd * 100) / 100;

/**
 * Historical prices from the hourly answer table. An event is valued at its hour's last answer, or the last answer of
 * the nearest earlier hour when its feed was quiet that hour. The stable asset is always one dollar.
 */
export class PriceHistory {
  private readonly byAsset = new Map<string, { readonly decimals: number; readonly hours: number[]; readonly answers: bigint[] }>();

  constructor(
    rows: readonly HourlyPrice[],
    feeds: readonly PricedFeed[],
    private readonly stable: string,
  ) {
    const assetOf = new Map(feeds.map((f) => [f.feed.toLowerCase(), f]));
    for (const r of rows) {
      const feed = assetOf.get(r.feed);
      if (!feed) continue;
      const key = feed.asset.toLowerCase();
      const series = this.byAsset.get(key) ?? { decimals: feed.decimals, hours: [], answers: [] };
      series.hours.push(r.hour);
      series.answers.push(BigInt(r.answer));
      this.byAsset.set(key, series);
    }
  }

  /** Null when the asset has no feed or its feed had not answered yet at `time`. */
  priceAt(asset: string, time: number): Price | null {
    const key = asset.toLowerCase();
    if (key === this.stable.toLowerCase()) return ONE_DOLLAR;
    const series = this.byAsset.get(key);
    if (!series) return null;
    const i = lastAtOrBefore(series.hours, hourOf(time));
    return i < 0 ? null : { answer: series.answers[i]!, decimals: series.decimals };
  }
}

/** Index of the last element `<= target` in an ascending array, or -1. */
export function lastAtOrBefore(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= target) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Percent change of `current` against `previous`; null when there is nothing to compare against. */
export function changePct(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}
