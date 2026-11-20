import { ColorType, type ChartOptions, type DeepPartial } from "lightweight-charts";

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Canvas charts can't read CSS, so the current theme's tokens are resolved and handed over on every theme change. */
export function chartTheme(): DeepPartial<ChartOptions> {
  return {
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: cssVar("--rq-ink-secondary"),
      fontFamily: cssVar("--rq-font-data-stack") || "IBM Plex Mono",
      attributionLogo: false,
    },
    grid: { vertLines: { color: cssVar("--rq-chart-grid") }, horzLines: { color: cssVar("--rq-chart-grid") } },
    rightPriceScale: { borderColor: cssVar("--rq-line") },
    timeScale: { borderColor: cssVar("--rq-line"), timeVisible: true },
  };
}

/** Calls `onChange` whenever the document switches between light and dark. Returns the unsubscribe. */
export function watchTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}
