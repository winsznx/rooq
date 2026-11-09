import type { Metadata } from "next";
import { PrivateLiquidity } from "@/components/private/liquidity";

export const metadata: Metadata = { title: "Liquidity" };

export default function Page() {
  return <PrivateLiquidity />;
}
