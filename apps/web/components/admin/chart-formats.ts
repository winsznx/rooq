import { ethUnits, usd, usdPrice } from "./format";
import type { ChartFormat } from "./time-chart";

export const USD_FORMAT: ChartFormat = { value: (v) => usd(v), minMove: 0.01 };
export const PRICE_FORMAT: ChartFormat = { value: usdPrice, minMove: 1e-10 };
export const ETH_FORMAT: ChartFormat = { value: (v) => ethUnits(v, 5), minMove: 1e-6 };
