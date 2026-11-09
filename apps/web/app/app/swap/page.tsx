import type { Metadata } from "next";
import { PrivateSwap } from "@/components/private/spot";

export const metadata: Metadata = { title: "Swap" };

export default function Page() {
  return <PrivateSwap />;
}
