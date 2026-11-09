import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "@/lib/providers";
import { THEME_BOOTSTRAP } from "@/lib/theme";

const sans = localFont({ src: "../public/brand/fonts/instrument-sans-latin-variable.woff2", weight: "400 700", style: "normal", variable: "--font-instrument-sans", display: "swap" });
const mono = localFont({
  src: [
    { path: "../public/brand/fonts/ibm-plex-mono-latin-400.woff2", weight: "400", style: "normal" },
    { path: "../public/brand/fonts/ibm-plex-mono-latin-500.woff2", weight: "500", style: "normal" },
    { path: "../public/brand/fonts/ibm-plex-mono-latin-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-mono",
  display: "swap",
});

const SHARE_DESCRIPTION = "Buy stock tokens like TSLA and AMZN or trade their price with leverage on Robinhood Chain, while your balances and positions stay out of public view. Testnet.";
const SHARE_IMAGE = { url: "/brand/social/og-private-1200x630.png", width: 1200, height: 630, alt: "Rooq. Private markets for stock tokens." };

export const metadata: Metadata = {
  title: { default: "Rooq | Private markets for stock tokens", template: "%s | Rooq" },
  keywords: ["private trading", "stock tokens", "tokenized stocks", "perpetuals", "private perps", "private spot", "zero-knowledge", "Robinhood Chain", "TSLA", "USDG"],
  description: SHARE_DESCRIPTION,
  applicationName: "Rooq",
  robots: { index: true, follow: true },
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3200"),
  openGraph: { title: "Rooq | Private markets for stock tokens", description: SHARE_DESCRIPTION, siteName: "Rooq", type: "website", images: [SHARE_IMAGE] },
  twitter: { card: "summary_large_image", title: "Rooq | Private markets for stock tokens", description: SHARE_DESCRIPTION, images: [SHARE_IMAGE] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
    { media: "(prefers-color-scheme: dark)", color: "#0C0F10" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body suppressHydrationWarning>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
