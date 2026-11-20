"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import type { AdminRange } from "@rooq/private-sdk/admin";
import { Segmented, type SegmentOption } from "@/components/primitives";
import { useAdminRange } from "@/lib/admin/hooks";

const OPTIONS: readonly SegmentOption<AdminRange>[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

export function RangePicker(): React.JSX.Element {
  const range = useAdminRange();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const select = (next: AdminRange): void => {
    const query = new URLSearchParams(params.toString());
    query.set("range", next);
    router.replace(`${pathname}?${query.toString()}` as Route, { scroll: false });
  };

  return <Segmented label="Time range" options={OPTIONS} value={range} onChange={select} />;
}
