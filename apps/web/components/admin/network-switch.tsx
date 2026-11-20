"use client";

import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Segmented, type SegmentOption } from "@/components/primitives";
import { useAdminRange, type AdminNetwork } from "@/lib/admin/hooks";
import { adminHref } from "./admin-href";

const OPTIONS: readonly SegmentOption<AdminNetwork>[] = [
  { value: "mainnet", label: "Mainnet" },
  { value: "testnet", label: "Testnet" },
];

/** Each network has its own front page, so switching always lands on /admin and keeps the range. */
export function NetworkSwitch({ value }: { value: AdminNetwork }): React.JSX.Element {
  const router = useRouter();
  const range = useAdminRange();
  const select = (next: AdminNetwork): void => {
    if (next !== value) router.push(adminHref("/admin", range, next) as Route);
  };
  return <Segmented label="Network" options={OPTIONS} value={value} onChange={select} />;
}
