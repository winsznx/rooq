/**
 * Local-only harness: a dedicated anvil, a fresh deployment and the services as separate OS processes. Used by
 * `start:local` and the integration test. Keys are anvil's public test keys, derived with `cast`, and synthetic seeds.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { depositOpening, deriveKeys, initCrypto, mulGenerator, noteInner, toHex32, type Point } from "@rooq/private-sdk";
import { createPublicClient, createWalletClient, http, parseAbi, type Abi, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { sleep } from "./chain";
import { PORTS, REPO_ROOT } from "./config";

const MNEMONIC = "test test test test test test test test test test test junk";
const APP_DIR = `${REPO_ROOT}apps/private-services`;

export const LOCAL_RPC_PORT = Number(process.env.PRIVATE_RPC_PORT ?? 8548);
export const LOCAL_RPC = `http://127.0.0.1:${LOCAL_RPC_PORT}`;

export type ServiceName = "read-api" | "relayer" | "queue" | "coordinator" | "risk-a" | "risk-b" | "maker";

export const SERVICE_PORTS: Record<ServiceName, number> = {
  "read-api": PORTS.readApi, relayer: PORTS.relayer, queue: PORTS.queue, coordinator: PORTS.coordinator, "risk-a": PORTS.riskA, "risk-b": PORTS.riskB, maker: PORTS.maker,
};

const SERVICE_FILES: Record<ServiceName, string> = {
  "read-api": "read-api", relayer: "relayer", queue: "queue", coordinator: "coordinator", "risk-a": "risk", "risk-b": "risk", maker: "maker",
};

export function anvilKey(index: number): Hex {
  return execFileSync("cast", ["wallet", "private-key", "--mnemonic", MNEMONIC, "--mnemonic-index", String(index)], { encoding: "utf8" }).trim() as Hex;
}

export interface LocalKeys {
  readonly deployer: Hex;
  readonly alice: Hex;
  readonly maker: Hex;
  readonly coordinatorTx: Hex;
  readonly riskATx: Hex;
  readonly riskBTx: Hex;
  readonly relayerTx: Hex;
  readonly queueTx: Hex;
}

export function localKeys(): LocalKeys {
  return { deployer: anvilKey(0), alice: anvilKey(1), maker: anvilKey(2), coordinatorTx: anvilKey(3), riskATx: anvilKey(4), riskBTx: anvilKey(5), relayerTx: anvilKey(6), queueTx: anvilKey(7) };
}

export const LOCAL_SCALARS = {
  coordinator: 0xc0041n, riskA: 0xa1a1n, riskB: 0xb2b2n, fee: 0xfee5eedn, maker: 0x3a4e45eedn, alice: 0xa11ce5eedn, rewardA: 0x1a5eedn, rewardB: 0x1b5eedn,
} as const;

export interface LocalDeployment {
  readonly pool: Address;
  readonly asset: Address;
  readonly feed: Address;
  readonly otherFeed: Address;
  readonly deploymentId: bigint;
  readonly market: bigint;
  readonly startBlock: number;
  readonly file: string;
  readonly spot: Address;
  readonly spotTokens: readonly Address[];
  readonly markets: Address;
  readonly thirdFeed: Address;
  readonly thirdFeedId: Hex;
}

export interface StackOptions {
  readonly logDir: string;
  /** `FOUNDRY_OUT` for the deployment; the services read the ABI from the same place. */
  readonly forgeOut: string;
  readonly deploymentFile: string;
  readonly inheritLogs: boolean;
  readonly serviceEnv?: Partial<Record<ServiceName, Record<string, string>>>;
  readonly pollMs: number;
  readonly proverThreads: number;
  /** Directory of compiled circuits, when the run should be insulated from a concurrent rebuild. */
  readonly circuitsDir?: string;
}

export class LocalStack {
  private anvil: ChildProcess | null = null;
  private readonly children = new Map<ServiceName, ChildProcess>();
  readonly keys = localKeys();
  deployment: LocalDeployment | null = null;

  constructor(readonly opts: StackOptions) {
    mkdirSync(opts.logDir, { recursive: true });
  }

  async startAnvil(): Promise<void> {
    if (await isListening(LOCAL_RPC_PORT)) throw new Error(`port ${LOCAL_RPC_PORT} is already in use`);
    const out = openSync(`${this.opts.logDir}/anvil.log`, "a");
    this.anvil = spawn("anvil", ["--port", String(LOCAL_RPC_PORT), "--chain-id", "31337", "--code-size-limit", "100000", "--gas-limit", "1000000000", "--silent"], { stdio: ["ignore", out, out] });
    closeSync(out);
    for (let i = 0; i < 100; i++) {
      if (await isListening(LOCAL_RPC_PORT)) return;
      await sleep(100);
    }
    throw new Error("anvil did not start");
  }

  async deploy(): Promise<LocalDeployment> {
    await initCrypto();
    const toEnv = (name: string, p: Point): Record<string, string> => ({ [`${name}_X`]: p.x.toString(), [`${name}_Y`]: p.y.toString() });
    const fee = deriveKeys(LOCAL_SCALARS.fee);
    const relative = `./deployments/${this.opts.deploymentFile.split("/").at(-1)}`;
    execFileSync("forge", ["script", "script/DeployPrivatePairs.s.sol", "--rpc-url", LOCAL_RPC, "--broadcast", "--slow", "--silent"], {
      cwd: `${REPO_ROOT}contracts`,
      env: {
        ...process.env, FOUNDRY_OUT: this.opts.forgeOut, FOUNDRY_CACHE_PATH: `${this.opts.forgeOut}/../cache`, DEPLOYER_PRIVATE_KEY: this.keys.deployer, PRIVACY_OUT: relative,
        ...toEnv("COORDINATOR", mulGenerator(LOCAL_SCALARS.coordinator)), ...toEnv("RISK_A", mulGenerator(LOCAL_SCALARS.riskA)), ...toEnv("RISK_B", mulGenerator(LOCAL_SCALARS.riskB)),
        FEE_AUTH: fee.auth.toString(), FEE_X: fee.pk.x.toString(), FEE_Y: fee.pk.y.toString(),
      },
      stdio: "pipe",
      maxBuffer: 256 * 1024 * 1024,
      timeout: 300_000,
    });
    const d = JSON.parse(readFileSync(this.opts.deploymentFile, "utf8")) as { pool: Address; asset: Address; feed: Address; otherFeed: Address; deploymentId: number | string; market: number; startBlock: number; spot: Address; spotTokens: Address[]; markets: Address; thirdFeed: Address; thirdFeedId: Hex };
    this.deployment = { pool: d.pool, asset: d.asset, feed: d.feed, otherFeed: d.otherFeed, deploymentId: BigInt(d.deploymentId), market: BigInt(d.market), startBlock: d.startBlock, file: this.opts.deploymentFile, spot: d.spot, spotTokens: d.spotTokens, markets: d.markets, thirdFeed: d.thirdFeed, thirdFeedId: d.thirdFeedId };
    return this.deployment;
  }

  private envFor(name: ServiceName): NodeJS.ProcessEnv {
    const common: Record<string, string> = {
      ROOQ_ENV: "local", RPC_URL: LOCAL_RPC, PRIVATE_DEPLOYMENT_FILE: this.opts.deploymentFile, ARTIFACTS_OUT: this.opts.forgeOut, POLL_MS: String(this.opts.pollMs), PROVER_THREADS: String(this.opts.proverThreads), PORT: String(SERVICE_PORTS[name]), PRIVATE_BASE_PORT: String(PORTS.readApi),
      ...(this.opts.circuitsDir ? { CIRCUITS_DIR: this.opts.circuitsDir } : {}),
    };
    const specific: Record<ServiceName, Record<string, string>> = {
      "read-api": {},
      relayer: { RELAYER_TX_KEY: this.keys.relayerTx },
      queue: { QUEUE_TX_KEY: this.keys.queueTx },
      coordinator: { COORDINATOR_SK: LOCAL_SCALARS.coordinator.toString(), COORDINATOR_TX_KEY: this.keys.coordinatorTx },
      "risk-a": { RISK_ID: "A", RISK_SK: LOCAL_SCALARS.riskA.toString(), RISK_TX_KEY: this.keys.riskATx, RISK_REWARD_SEED: LOCAL_SCALARS.rewardA.toString() },
      "risk-b": { RISK_ID: "B", RISK_SK: LOCAL_SCALARS.riskB.toString(), RISK_TX_KEY: this.keys.riskBTx, RISK_REWARD_SEED: LOCAL_SCALARS.rewardB.toString() },
      maker: { MAKER_SEED: LOCAL_SCALARS.maker.toString(), MAKER_TERMS: `1:20:${100n * 10n ** 18n}:30:${300n * 10n ** 6n}:2,2:20:${100n * 10n ** 18n}:30:${300n * 10n ** 6n}:1,100:20:${100n * 10n ** 18n}:30:${300n * 10n ** 6n}:1` },
    };
    return { PATH: process.env.PATH, HOME: process.env.HOME, ...common, ...specific[name], ...this.opts.serviceEnv?.[name] };
  }

  start(name: ServiceName): void {
    const file = `src/services/${SERVICE_FILES[name]}.ts`;
    const env = this.envFor(name);
    if (this.opts.inheritLogs) {
      this.children.set(name, spawn("bun", ["run", file], { cwd: APP_DIR, env, stdio: "inherit" }));
      return;
    }
    const out = openSync(`${this.opts.logDir}/${name}.log`, "a");
    this.children.set(name, spawn("bun", ["run", file], { cwd: APP_DIR, env, stdio: ["ignore", out, out] }));
    closeSync(out);
  }

  startAll(): void {
    for (const name of Object.keys(SERVICE_PORTS) as ServiceName[]) this.start(name);
  }

  child(name: ServiceName): ChildProcess | undefined {
    return this.children.get(name);
  }

  async stop(name: ServiceName, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const child = this.children.get(name);
    if (!child) return;
    const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill(signal);
    await done;
    this.children.delete(name);
  }

  async stopAll(): Promise<void> {
    for (const name of [...this.children.keys()]) await this.stop(name, "SIGKILL");
    if (this.anvil) {
      this.anvil.kill("SIGKILL");
      this.anvil = null;
    }
  }
}

export async function isListening(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}`, { method: "HEAD", signal: AbortSignal.timeout(500) });
    return res.status > 0;
  } catch {
    return false;
  }
}

export const writeJson = (path: string, value: unknown): void =>
  writeFileSync(path, JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2));

const erc20Abi = parseAbi(["function mintTo(address,uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

export interface LocalClients {
  readonly client: PublicClient<Transport, Chain>;
  wallet(key: Hex): WalletClient<Transport, Chain, Account>;
}

export function localClients(rpc = LOCAL_RPC): LocalClients {
  const chain = foundry;
  const client = createPublicClient({ chain, transport: http(rpc) });
  return {
    client: client as unknown as PublicClient<Transport, Chain>,
    wallet: (key) => createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(rpc) }) as unknown as WalletClient<Transport, Chain, Account>,
  };
}

/** Mints test tokens to the EOA of `key`, approves the pool and shields `amounts` as this seed's k-th deposits. */
export async function shieldDeposits(c: LocalClients, deployerKey: Hex, key: Hex, pool: Address, asset: Address, abi: Abi, seed: bigint, startK: number, amounts: readonly bigint[]): Promise<void> {
  const owner = deriveKeys(seed).owner;
  const total = amounts.reduce((a, b) => a + b, 0n);
  const eoa = privateKeyToAccount(key).address;
  const send = async (wallet: WalletClient<Transport, Chain, Account>, to: Address, data: readonly unknown[], fn: string, callAbi: Abi = erc20Abi): Promise<void> => {
    const hash = await wallet.writeContract({ address: to, abi: callAbi, functionName: fn, args: data, chain: foundry });
    const r = await c.client.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${fn} reverted`);
  };
  await send(c.wallet(deployerKey), asset, [eoa, total], "mintTo");
  await send(c.wallet(key), asset, [pool, total], "approve");
  for (const [i, amount] of amounts.entries()) {
    const { rho, blind } = depositOpening(seed, startK + i);
    await send(c.wallet(key), pool, [asset, amount, toHex32(noteInner(owner, rho, blind))], "shield", abi);
  }
}
