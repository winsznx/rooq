import type { MetadataRoute } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3200";
const PUBLIC_PATHS = ["", "/how-it-works", "/learn", "/developers", "/status", "/app/markets", "/app/trade", "/app/swap", "/app/liquidity"];

export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_PATHS.map((path) => ({ url: `${SITE_URL}${path}`, changeFrequency: "weekly", priority: path === "" ? 1 : 0.7 }));
}
