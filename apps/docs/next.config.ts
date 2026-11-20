import type { NextConfig } from "next";

/** The cookieless pageview beacon in components/analytics/beacon.tsx posts here. */
const PV_URL = process.env.NEXT_PUBLIC_PV_URL ?? (process.env.NODE_ENV === "production" ? "https://api.rooq.trade/v1/pv" : "http://127.0.0.1:8718/v1/pv");

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${new URL(PV_URL).origin}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  poweredByHeader: false,
  typedRoutes: false,
  transpilePackages: ["@rooq/config", "@rooq/private-sdk", "@rooq/ui"],
  async rewrites() {
    return [{ source: "/:slug.md", destination: "/md/:slug" }];
  },
  async redirects() {
    return [{ source: "/introduction", destination: "/", permanent: true }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
