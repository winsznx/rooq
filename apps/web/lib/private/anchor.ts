/**
 * Ties what the read API serves to the chain (internal audit finding 28). The wallet builds the note tree from the
 * API's leaves; the root is accepted only if the pool contract has recorded it, and every record and deposit the
 * wallet decodes must be the leaf at its index in that tree. A dishonest read API can then withhold data but can't
 * show money that doesn't exist.
 */
export interface LeafSource {
  readonly size: number;
  leaf(index: number): bigint | undefined;
}

export interface IndexedRow {
  readonly leafIndex: number;
}

/**
 * True when the pool has ever recorded `root`. rootSeqOf is nonzero for every root the contract produced, including
 * ones older than its 64-root window, so a read API that lags the chain still passes. The RPC can lag the read API by
 * a block, so a miss is retried before it counts.
 */
export async function rootOnChain(rootSeqOf: () => Promise<bigint>, retries = 2, delayMs = 1_500): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    if ((await rootSeqOf()) !== 0n) return true;
    if (attempt >= retries) return false;
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

/**
 * Checks rows from `from` on whose leaf is already in the tree. Returns where to resume next time, or the first row
 * whose commitment isn't the tree's leaf at its index. Rows are in leaf order, so the scan stops at the first one past
 * the tree; those wait for a later sync.
 */
export function checkRows<T extends IndexedRow>(rows: readonly T[], from: number, tree: LeafSource, commitmentOf: (row: T) => bigint): { next: number; bad: T | null } {
  let i = from;
  for (; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.leafIndex >= tree.size) break;
    if (tree.leaf(row.leafIndex) !== commitmentOf(row)) return { next: i, bad: row };
  }
  return { next: i, bad: null };
}

/** The highest leaf index among rows not yet in the tree, or -1. Each must exist in the on-chain queue. */
export function highestPending(rows: readonly IndexedRow[], treeSize: number): number {
  let max = -1;
  for (const r of rows) if (r.leafIndex >= treeSize && r.leafIndex > max) max = r.leafIndex;
  return max;
}
