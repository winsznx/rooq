"use client";

import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, darkTheme, lightTheme } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { MotionConfig } from "motion/react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { TRANSITION } from "./motion";
import { wagmiConfig } from "./wagmi";
import { ToastProvider } from "@/components/feedback/toast";

/** Publishes the on-screen keyboard's height so sticky actions and sheets can stay above it. */
function useKeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const apply = () => {
      const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      root.style.setProperty("--rq-kb-h", `${inset}px`);
      root.dataset.keyboard = inset > 80 ? "open" : "closed";
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
    };
  }, []);
}

export function Providers({ children }: { children: ReactNode }) {
  useKeyboardInset();
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 2_000 },
        },
      }),
  );
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider appInfo={{ appName: "Rooq" }} theme={{ lightMode: lightTheme({ accentColor: "#0C0F10", borderRadius: "large" }), darkMode: darkTheme({ accentColor: "#F5F7F7", accentColorForeground: "#0C0F10", borderRadius: "large" }) }}>
        <MotionConfig reducedMotion="user" transition={TRANSITION.select}>
          <Tooltip.Provider delayDuration={200}>
            <ToastProvider>{children}</ToastProvider>
          </Tooltip.Provider>
        </MotionConfig>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
