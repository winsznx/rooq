import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createWalletClient,
  http,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Deployment } from "@rooq/config";
import { marginVaultAbi, mockERC20Abi, spotRouterAbi } from "@rooq/sdk";
import type { Db } from "../db";
import { log } from "../log";

/** Anvil default key 5. Local only; never funded anywhere real. */
export const DRILL_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const;
export const SOURCE_RPC = process.env.DRILL_SOURCE_RPC ?? "http://127.0.0.1:8545";
export const EVIDENCE_DIR = join(import.meta.dir, "../../../../docs/evidence");

export interface Fork {
  readonly url: string;
  readonly stop: () => Promise<void>;
}

async function rpcCall(url: string, method: string, params: readonly unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null) throw new Error(`${method}: malformed response`);
  if ("error" in body && body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return "result" in body ? body.result : null;
}

export const rpc = rpcCall;

/** Starts a throwaway anvil forked from the shared local node; the shared node is only read. */
export async function startFork(port: number): Promise<Fork> {
  const url = `http://127.0.0.1:${port}`;
  const busy = await rpcCall(url, "eth_chainId").then(
    () => true,
    () => false,
  );
  if (busy) throw new Error(`port ${port} already serves an RPC; refusing to reuse it for a drill`);
  const proc = Bun.spawn(["anvil", "--port", String(port), "--fork-url", SOURCE_RPC, "--silent"], { stdout: "ignore", stderr: "pipe" });
  for (let i = 0; i < 100; i += 1) {
    const ready = await rpcCall(url, "eth_chainId").then(
      () => true,
      () => false,
    );
    if (ready) {
      log("drill_fork_started", { url, source: SOURCE_RPC, pid: proc.pid });
      return {
        url,
        stop: async () => {
          proc.kill("SIGTERM");
          await proc.exited;
          log("drill_fork_stopped", { url });
        },
      };
    }
    await Bun.sleep(100);
  }
  proc.kill("SIGKILL");
  throw new Error(`anvil fork on ${port} did not become ready`);
}

export async function resetSchema(sql: Db, schema: string): Promise<void> {
  if (!schema.startsWith("drill_")) throw new Error(`refusing to drop non-drill schema ${schema}`);
  await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
  await sql`CREATE SCHEMA ${sql(schema)}`;
}

export interface SentTx {
  readonly step: string;
  readonly hash: Hash;
  readonly block: string;
  readonly status: string;
  readonly logs: number;
}

export class DrillWallet {
  readonly account: Account;
  private readonly wallet: WalletClient<Transport, Chain, Account>;

  constructor(
    private readonly client: PublicClient<Transport, Chain>,
    private readonly dep: Deployment,
    chain: Chain,
    rpcUrl: string,
  ) {
    this.account = privateKeyToAccount(DRILL_KEY);
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(rpcUrl, { timeout: 5_000 }) });
  }

  get address(): Address {
    return this.account.address;
  }

  private async send(step: string, hash: Hash): Promise<SentTx> {
    const r = await this.client.waitForTransactionReceipt({ hash, timeout: 15_000 });
    if (r.status !== "success") throw new Error(`${step} reverted (${hash})`);
    return { step, hash, block: r.blockNumber.toString(), status: r.status, logs: r.logs.length };
  }

  faucet(amount: bigint): Promise<SentTx> {
    return this.wallet
      .writeContract({ address: this.dep.collateral, abi: mockERC20Abi, functionName: "faucet", args: [amount] })
      .then((h) => this.send(`faucet ${amount}`, h));
  }

  approve(spender: Address, amount: bigint): Promise<SentTx> {
    return this.wallet
      .writeContract({ address: this.dep.collateral, abi: mockERC20Abi, functionName: "approve", args: [spender, amount] })
      .then((h) => this.send(`approve ${spender} ${amount}`, h));
  }

  deposit(amount: bigint): Promise<SentTx> {
    return this.wallet
      .writeContract({ address: this.dep.marginVault, abi: marginVaultAbi, functionName: "deposit", args: [amount, this.address] })
      .then((h) => this.send(`deposit ${amount}`, h));
  }

  withdraw(amount: bigint): Promise<SentTx> {
    return this.wallet
      .writeContract({ address: this.dep.marginVault, abi: marginVaultAbi, functionName: "withdraw", args: [amount, this.address] })
      .then((h) => this.send(`withdraw ${amount}`, h));
  }

  async swapCollateralForBase(amountIn: bigint): Promise<SentTx> {
    const market = this.dep.markets.find((m) => m.feedMode === "relay");
    if (!market) throw new Error("no relay market in deployment");
    const block = await this.client.getBlock();
    const path: readonly Address[] = [this.dep.collateral, market.base];
    const fees = [Number(market.poolFee)];
    const hash = await this.wallet.writeContract({
      address: this.dep.spotRouter,
      abi: spotRouterAbi,
      functionName: "swapExactInput",
      args: [path, fees, amountIn, 0n, this.address, block.timestamp + 600n],
    });
    return this.send(`swap ${amountIn} collateral for ${market.symbol}`, hash);
  }
}

export interface Assertion {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: unknown;
}

export class Assertions {
  readonly list: Assertion[] = [];

  check(name: string, ok: boolean, detail: unknown): void {
    this.list.push({ name, ok, detail });
    log(ok ? "drill_assert_ok" : "drill_assert_failed", { name, detail });
  }

  get ok(): boolean {
    return this.list.every((a) => a.ok);
  }
}

export function writeEvidence(file: string, body: unknown): string {
  const path = join(EVIDENCE_DIR, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
  return path;
}
