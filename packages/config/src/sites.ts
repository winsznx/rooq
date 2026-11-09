/**
 * Public hostnames, each set once. `NEXT_PUBLIC_DOCS_URL` moves the docs site and every link to it.
 * Local development falls back to the docs dev server.
 */
const isProduction = process.env.NODE_ENV === "production";

export const DOCS_URL: string = trimSlash(process.env.NEXT_PUBLIC_DOCS_URL ?? (isProduction ? "https://docs.rooq.trade" : "http://localhost:3300"));
export const APP_URL: string = trimSlash(process.env.NEXT_PUBLIC_APP_URL ?? (isProduction ? "https://rooq.trade" : "http://localhost:3200"));
export const SUPPORT_EMAIL: string = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "support@rooq.trade";

/** A page on the docs site, for links from other apps. */
export function docsUrl(path = ""): string {
  return path === "" ? DOCS_URL : `${DOCS_URL}/${path.replace(/^\/+/, "")}`;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
