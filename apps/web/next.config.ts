import { execFileSync } from "node:child_process";
import type { NextConfig } from "next";
import { connectSources } from "./lib/csp";

const isDev = process.env.NODE_ENV !== "production";

function gitRevision(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** A dated id stands in when the checkout has no commit to name. Development keeps the status bar's "dev". */
const buildId = isDev ? null : process.env.NEXT_PUBLIC_BUILD_ID ?? process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? gitRevision() ?? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

const connect = connectSources(isDev).join(" ");

/** For pages outside /app. The app itself gets a per-request nonce policy from proxy.ts. */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src ${connect}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  env: buildId ? { NEXT_PUBLIC_BUILD_ID: buildId } : {},
  reactStrictMode: true,
  turbopack: { resolveAlias: { "@base-org/account": "./lib/empty-module.ts" } },
  agentRules: false,
  transpilePackages: ["@rooq/sdk", "@rooq/config", "@rooq/ui", "@rooq/private-sdk"],
  typedRoutes: true,
  poweredByHeader: false,
  images: {
    remotePatterns: [],
  },
  async headers() {
    return [
      { source: "/((?!app(?:/|$)).*)", headers: [{ key: "Content-Security-Policy", value: csp }] },
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // Threaded proving needs SharedArrayBuffer. `credentialless` keeps no-cors images working without CORP headers,
          // and the app only ships injected wallets, which `same-origin` does not affect (a popup-based wallet would need rework).
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
};

export default nextConfig;
