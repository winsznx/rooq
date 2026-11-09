import { APPEND_BATCH, appendWitness, toHex32 } from "@rooq/private-sdk";
import { bytesToHex } from "./chain";
import type { Provers } from "./provers";
import type { Sender } from "./sender";
import type { ServiceContext } from "./service";

/**
 * Proves and submits one batch of the oldest queued entries. Shared by the queue service and the risk workers' fallback,
 * so the same code path keeps liquidations possible when the queue service is down. Anyone may do this, so a race
 * against another processor is expected: `done` tells the caller to resync and look again.
 */
export async function processQueueOnce(ctx: ServiceContext, sender: Sender, provers: Provers): Promise<{ done: boolean }> {
  const { ledger, log } = ctx;
  const processed = ledger.processed;
  const pending = ledger.queueLength - processed;
  if (pending <= 0) return { done: true };
  const count = Math.min(APPEND_BATCH, pending);
  const entries = ledger.queue.slice(processed, processed + count);
  const { inputs, newRoot } = appendWitness(ledger.tree.clone(), entries, ctx.chain.deploymentId);
  const proof = await (await provers.get("append")).prove(inputs);
  const outcome = await sender.send("processQueue", [bytesToHex(proof.proof), toHex32(newRoot)]);
  if (outcome.status === "confirmed") {
    ctx.bump("batches");
    ctx.bump("leaves", count);
    ctx.recordAction("processQueue", outcome.hash);
    return { done: false };
  }
  if (outcome.status === "timeout") return { done: true };
  // A competing processor, or a reorg, moved the root under this proof. Resync and re-prove.
  if (outcome.revert.reason === "INVALID_PROOF" || outcome.revert.reason === "NOTHING_QUEUED") {
    ctx.bump("queueRacesLost");
    log.debug("queue_race_lost", { reason: outcome.revert.reason });
    return { done: false };
  }
  log.warn("queue_submit_failed", { reason: outcome.revert.reason });
  return { done: true };
}
