/** Keeps ShieldedPool.processQueue moving: permissionless batches proved with the append circuit from chain data alone. */
import { intEnv, PORTS, takePrivateKey } from "../lib/config";
import { Provers } from "../lib/provers";
import { Sender } from "../lib/sender";
import { runService } from "../lib/service";
import { processQueueOnce } from "../lib/queue-step";

await runService({
  name: "queue",
  port: intEnv(process.env, "PORT", PORTS.queue, 1),
  init(ctx) {
    const sender = new Sender(ctx.chain, takePrivateKey(process.env, "QUEUE_TX_KEY"), ctx.log);
    const provers = new Provers(ctx.config.proverThreads);
    return {
      async tick() {
        const pending = ctx.ledger.queueLength - ctx.ledger.processed;
        ctx.liveness.backlog = { queued: pending };
        for (let guard = 0; guard < 16 && ctx.ledger.queueLength > ctx.ledger.processed; guard++) {
          const result = await processQueueOnce(ctx, sender, provers);
          if (result.done) break;
          await ctx.ledger.sync();
        }
        ctx.liveness.backlog = { queued: ctx.ledger.queueLength - ctx.ledger.processed };
      },
      shutdown: () => provers.destroyAll(),
    };
  },
});
