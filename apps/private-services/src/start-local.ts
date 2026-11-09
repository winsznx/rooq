/**
 * One command for the whole private stack against a dedicated local chain:
 *   pnpm --filter @rooq/private-services start:local
 * Anvil on 8548, a fresh deployment, a funded maker wallet and every service as its own process on 8710 to 8716.
 * A crashed service is restarted. Local only: anvil's public keys and synthetic seeds.
 */
import { tmpdir } from "node:os";
import { sleep, loadPoolAbi } from "./lib/chain";
import { REPO_ROOT } from "./lib/config";
import { LOCAL_RPC, LOCAL_SCALARS, LocalStack, localClients, SERVICE_PORTS, shieldDeposits, type ServiceName } from "./lib/localstack";

const USD = 1_000_000n;
const stack = new LocalStack({
  logDir: `${REPO_ROOT}.local-logs/private-services`,
  forgeOut: process.env.FORGE_OUT ?? `${tmpdir()}/rooq-private-services-forge/out`,
  deploymentFile: `${REPO_ROOT}contracts/deployments/privacy-e2e-services.json`,
  inheritLogs: true,
  pollMs: 1_000,
  proverThreads: 4,
});

let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await stack.stopAll();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await stack.startAnvil();
const d = await stack.deploy();
console.log(`deployed PrivatePairs ${d.pool} on ${LOCAL_RPC}`);
await shieldDeposits(localClients(), stack.keys.deployer, stack.keys.maker, d.pool, d.asset, loadPoolAbi(stack.opts.forgeOut), LOCAL_SCALARS.maker, 0, Array.from({ length: 6 }, () => 1_000n * USD));
stack.startAll();
for (const [name, port] of Object.entries(SERVICE_PORTS)) console.log(`${name.padEnd(12)} http://127.0.0.1:${port}/health`);

for (;;) {
  await sleep(1_000);
  if (stopping) break;
  for (const name of Object.keys(SERVICE_PORTS) as ServiceName[]) {
    const child = stack.child(name);
    if (child && child.exitCode !== null) {
      console.log(`${name} exited (${child.exitCode}); restarting`);
      stack.start(name);
    }
  }
}
