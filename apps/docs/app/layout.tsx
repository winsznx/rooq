import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { DocsChrome } from "@/components/docs-chrome";
import { Footer } from "@/components/footer";
import { DOCS_URL, SITE_NAME } from "@/lib/site";
import { mono, sans } from "./fonts";
import "./globals.css";

const description = "How Rooq works: private spot and perps for stock tokens on Robinhood Chain testnet. What others can see, what you can lose and how to use it.";

const SHARE_IMAGE = { url: "/social/og-1200x630.png", width: 1200, height: 630, alt: "How private trading works on Rooq." };

export const metadata: Metadata = {
  metadataBase: new URL(DOCS_URL),
  title: { default: SITE_NAME, template: `%s | ${SITE_NAME}` },
  description,
  applicationName: SITE_NAME,
  openGraph: { type: "website", siteName: SITE_NAME, title: SITE_NAME, description, url: DOCS_URL, images: [SHARE_IMAGE] },
  twitter: { card: "summary_large_image", title: SITE_NAME, description, images: [SHARE_IMAGE] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
    { media: "(prefers-color-scheme: dark)", color: "#0C0F10" },
  ],
};

const THEME_BOOTSTRAP = `try{var t=localStorage.getItem("rooq-docs-theme");document.documentElement.dataset.theme=t==="dark"?"dark":"light"}catch(e){document.documentElement.dataset.theme="light"}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html className={`${sans.variable} ${mono.variable}`} data-theme="light" lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <DocsChrome footer={<Footer />}>{children}</DocsChrome>
      </body>
    </html>
  );
}
