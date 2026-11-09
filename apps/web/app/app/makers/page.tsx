import type { Metadata } from "next";
import { PrivateMakers } from "@/components/private/makers";

export const metadata: Metadata = { title: "Makers" };

export default function Page() {
  return <PrivateMakers />;
}
