import type { AdminRange } from "@rooq/private-sdk/admin";

export const RANGE_LABEL: Record<AdminRange, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "Since deployment",
};
