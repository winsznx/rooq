import type { Metadata } from "next";
import { PrivateCreate } from "@/components/private/create";

export const metadata: Metadata = { title: "Create a market" };

export default function CreatePage() {
  return <PrivateCreate />;
}
