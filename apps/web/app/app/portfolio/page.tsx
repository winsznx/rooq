import type { Metadata } from "next";
import { PrivatePortfolio } from "@/components/private/portfolio";

export const metadata: Metadata = { title: "Portfolio" };

export default function Page() {
  return <PrivatePortfolio />;
}
