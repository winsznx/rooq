import localFont from "next/font/local";

export const sans = localFont({ src: "./fonts/instrument-sans-latin-variable.woff2", weight: "400 700", variable: "--font-sans", display: "swap" });

export const mono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-latin-400.woff2", weight: "400" },
    { path: "./fonts/ibm-plex-mono-latin-500.woff2", weight: "500" },
  ],
  variable: "--font-mono",
  display: "swap",
});
