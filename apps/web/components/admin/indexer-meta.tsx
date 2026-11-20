"use client";

import { formatAge } from "@rooq/sdk";
import type { AdminIndexerState } from "@rooq/private-sdk/admin";
import { useNow } from "@/lib/use-now";
import { count } from "./format";

export function IndexerMeta({ indexer }: { indexer: AdminIndexerState }): React.JSX.Element {
  const now = useNow();
  return (
    <>
      {indexer.backfilling ? (
        <span className="pill" data-tone="warning">
          Backfilling
        </span>
      ) : null}
      <span className="num">{`Indexed to block ${indexer.indexedBlock.toLocaleString("en-US")}`}</span>
      <span className={indexer.lagBlocks > 0 ? undefined : "faint"}>{`${count(indexer.lagBlocks)} blocks behind head`}</span>
      <span className="faint">{`Updated ${formatAge(now - indexer.updatedAt)}`}</span>
    </>
  );
}
