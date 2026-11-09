import type { Hex } from "viem";
import type { StreamEnvelope } from "@rooq/sdk";
import type { Db } from "./db";
import { history } from "./db";
import { badRequest } from "./errors";
import { maxStreamSeq, streamAfter, syncState, type StreamRow } from "./history";
import { stringify } from "./http";
import { logError } from "./log";

const POLL_MS = 1_000;
const KEEPALIVE_MS = 15_000;
const BATCH = 500;
const STREAM_TYPES: ReadonlySet<string> = new Set<StreamEnvelope["type"]>([
  "market.tick",
  "pool.swap",
  "perp.trade",
  "position.changed",
  "market.status",
  "indexer.sync",
  "tx.status",
]);

function isStreamType(value: string): value is StreamEnvelope["type"] {
  return STREAM_TYPES.has(value);
}

export function toEnvelope(chainId: number, row: StreamRow): StreamEnvelope {
  if (!isStreamType(row.type)) throw new Error(`unknown stream type ${row.type}`);
  return {
    type: row.type,
    chainId,
    marketId: row.market_id,
    blockNumber: row.block_number.toString(),
    blockHash: row.block_hash,
    txHash: row.tx_hash,
    logIndex: row.log_index,
    eventId: row.event_id,
    observedAt: row.observed_at.toISOString(),
    reverted: row.reverted,
    payload: row.payload,
    schemaVersion: 1,
  };
}

/** SSE frame. Data events carry the stream sequence as `id`, which EventSource replays as Last-Event-ID. */
export function sseFrame(data: unknown, id?: bigint): string {
  return `${id === undefined ? "" : `id: ${id}\n`}data: ${stringify(data)}\n\n`;
}

export function parseLastEventId(raw: string | null): bigint | null {
  if (raw === null || raw === "") return null;
  if (!/^\d{1,20}$/.test(raw)) throw badRequest("Last-Event-ID must be a stream sequence number.");
  return BigInt(raw);
}

/**
 * Opens one SSE connection. Without Last-Event-ID it starts at the newest indexed event; with it,
 * it replays everything after that sequence (tombstones included) before going live. Reorged rows
 * arrive again with `reverted: true`; `indexer.sync` frames carry no id so they never move the resume point.
 */
export async function openStream(
  sql: Db,
  chainId: number,
  opts: { lastEventId: bigint | null; marketId: Hex | null; signal: AbortSignal; headers: Record<string, string> },
): Promise<Response> {
  let cursor = opts.lastEventId ?? (await history(sql, (q) => maxStreamSeq(q, chainId)));
  const encoder = new TextEncoder();
  let closed = false;
  let busy = false;
  let lastSync: string | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    closed = true;
    clearInterval(poll);
    clearInterval(keepalive);
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch (error) {
          logError("sse_enqueue_failed", error);
          stop();
        }
      };
      const tick = async () => {
        if (closed || busy) return;
        busy = true;
        try {
          for (;;) {
            const rows = await streamAfter(sql, chainId, cursor, opts.marketId, BATCH);
            for (const row of rows) {
              send(sseFrame(toEnvelope(chainId, row), row.seq));
              cursor = row.seq;
            }
            if (rows.length < BATCH || closed) break;
          }
          const sync = await syncState(sql, chainId);
          const key = sync ? `${sync.last_indexed_block}:${sync.status}` : null;
          if (sync && sync.last_indexed_block !== null && sync.last_indexed_hash !== null && key !== lastSync) {
            lastSync = key;
            const envelope: StreamEnvelope = {
              type: "indexer.sync",
              chainId,
              marketId: null,
              blockNumber: sync.last_indexed_block.toString(),
              blockHash: sync.last_indexed_hash,
              txHash: null,
              logIndex: null,
              eventId: `${chainId}:sync:${sync.last_indexed_block}`,
              observedAt: new Date().toISOString(),
              reverted: false,
              payload: { status: sync.status, lastIndexedBlock: sync.last_indexed_block.toString() },
              schemaVersion: 1,
            };
            send(sseFrame(envelope));
          }
        } catch (error) {
          logError("sse_poll_failed", error);
          send(": indexer database unavailable, retrying\n\n");
        } finally {
          busy = false;
        }
      };
      send("retry: 3000\n\n");
      poll = setInterval(() => void tick(), POLL_MS);
      keepalive = setInterval(() => send(`: keepalive ${Date.now()}\n\n`), KEEPALIVE_MS);
      void tick();
    },
    cancel() {
      stop();
    },
  });
  opts.signal.addEventListener("abort", stop, { once: true });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...opts.headers,
    },
  });
}
