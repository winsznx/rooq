import type { Metadata } from "next";
import { PrivateMakers } from "@/components/private/makers";

export const metadata: Metadata = { title: "Maker desk" };

export default function Page() {
  return <PrivateMakers />;
}
