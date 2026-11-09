/** Example data for the landing demo. Nothing here reads a wallet, a chain or a real price. */
export interface DemoToken {
  readonly key: "TSLA" | "AMZN" | "PLTR" | "NFLX" | "AMD";
  readonly name: string;
  readonly price: number;
  readonly vol: number;
}

export const TOKENS: readonly DemoToken[] = [
  { key: "TSLA", name: "Tesla", price: 374.2, vol: 0.021 },
  { key: "AMZN", name: "Amazon", price: 221.84, vol: 0.012 },
  { key: "PLTR", name: "Palantir", price: 118.46, vol: 0.028 },
  { key: "NFLX", name: "Netflix", price: 96.12, vol: 0.015 },
  { key: "AMD", name: "AMD", price: 201.37, vol: 0.024 },
];

export const LOGOS: Record<string, string> = {
  TSLA: "/logos/tsla.png",
  AMZN: "/logos/amzn.png",
  PLTR: "/logos/pltr.png",
  NFLX: "/logos/nflx.png",
  AMD: "/logos/amd.png",
  USDG: "/logos/usdg.png",
};

export type Timeframe = "15m" | "1h" | "4h" | "1d";
export const TIMEFRAMES: readonly Timeframe[] = ["15m", "1h", "4h", "1d"];
const STEP_SECONDS: Record<Timeframe, number> = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const TF_SCALE: Record<Timeframe, number> = { "15m": 0.45, "1h": 0.8, "4h": 1.45, "1d": 2.6 };

export interface Candle {
  readonly t: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
  readonly mark: number;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COUNT = 120;
const END_TIME = 1_794_000_000;

/** A seeded walk: drifting regimes, volatility clusters and mean reversion, so every market and timeframe looks different. */
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

export function series(token: DemoToken, tf: Timeframe): Candle[] {
  const rand = mulberry32(hash(`${token.key}:${tf}`));
  const step = token.vol * TF_SCALE[tf];
  const closes: number[] = [];
  let x = 0;
  let drift = (rand() - 0.5) * step * 0.5;
  let heat = 1;
  for (let i = 0; i < COUNT; i++) {
    if (rand() < 0.07) drift = (rand() - 0.5) * step * 0.9;
    heat = 0.9 * heat + 0.1 * (rand() < 0.09 ? 3.2 : 0.9);
    x += drift - x * 0.018 + (rand() - 0.5) * step * heat * 1.3;
    closes.push(x);
  }
  const shift = closes[closes.length - 1]!;
  const stepSeconds = STEP_SECONDS[tf];
  const out: Candle[] = [];
  let mark = token.price * Math.exp(closes[0]! - shift);
  let prev = mark;
  closes.forEach((value, i) => {
    const c = token.price * Math.exp(value - shift);
    const span = Math.abs(c - prev) + token.price * step * (0.16 + rand() * 0.46);
    const h = Math.max(c, prev) + span * rand() * 0.55;
    const l = Math.min(c, prev) - span * rand() * 0.55;
    mark += (c - mark) * 0.3;
    // Rounded because Math.exp differs in the last bits between the server and the browser, which breaks hydration.
    out.push({ t: END_TIME - (COUNT - 1 - i) * stepSeconds, o: round4(prev), h: round4(h), l: round4(l), c: round4(c), v: round4((0.25 + rand() * 0.75) * (1 + (Math.abs(c - prev) / (token.price * step)) * 2.4)), mark: round4(mark) });
    prev = c;
  });
  return out;
}

export function money(value: number, digits = 2): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function signedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function formatTime(t: number, tf: Timeframe): string {
  const d = new Date(t * 1000);
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = d.getUTCDate();
  const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return tf === "1d" ? `${month} ${day}` : tf === "15m" ? hhmm : `${month} ${day}`;
}

export const TOKEN_MAP = Object.fromEntries(TOKENS.map((t) => [t.key, t])) as Record<DemoToken["key"], DemoToken>;
