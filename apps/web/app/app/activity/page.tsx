import type { Metadata } from "next";
import { PrivateActivity } from "@/components/private/activity";

export const metadata: Metadata = { title: "Activity" };

export default function Page() {
  return <PrivateActivity />;
}
