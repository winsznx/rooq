/**
 * Submits wallet-prepared proofs. It sees only what will become public anyway, holds no user secrets and never signs for
 * users. A job's id is the keccak of its calldata, so a retry of the same request is the same job, before and after a
 * restart. Restart recovery comes from the chain: confirmed jobs are rebuilt from this key's own past transactions.
 */
import { deriveKeys, type WalletKeys } from "@rooq/private-sdk";
import { intEnv, PORTS, takePrivateKey, takeScalar } from "../lib/config";
import { json, readJson, type Route } from "../lib/http";
import { allowanceLimits, frontedBonds, RelayAllowance, retryLimitReached, type AllowanceLimits } from "../lib/relay-allowance";
import { isRelayAction, MAX_BODY_BYTES, parseRelayRequest, SERVICE_TOKEN_HEADER, type RelayAction, type RelayCall } from "../lib/relay-codec";
import { FeeTable, serviceTokenValid, settleFee } from "../lib/relay-fee";
import { ServiceError } from "../lib/errors";
import { Sender, type Broadcast } from "../lib/sender";
import { runService, type ServiceContext } from "../lib/service";
import { encodeFunctionData, keccak256, decodeFunctionData, type Hex } from "viem";

type JobStatus = "pending" | "confirmed" | "reverted" | "reorged";

interface Job {
  readonly id: Hex;
  readonly action: RelayAction;
  status: JobStatus;
  reasonCode: string | null;
  tx: Hex | null;
  raw: Hex | null;
  block: bigint | null;
  blockHash: Hex | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  call: RelayCall | null;
}

/** Past transactions read at once during startup recovery; a public RPC rate-limits larger bursts. */
const RECOVERY_BATCH = 4;
const RECOVERY_PASSES = 3;
const MAX_JOBS = 20_000;
const RELAY_PER_MINUTE = 60;
const MAX_BACKLOG = 64;
const MIN_GAS_BALANCE = 10n ** 15n;

class Relayer {
  private readonly jobs = new Map<Hex, Job>();
  private readonly byTx = new Map<Hex, Hex>();
  private readonly inFlight = new Map<Hex, Hex>();
  private readonly finalityBlocks: bigint;
  private readonly rebroadcastMs: number;
  private recovered = false;
  private recoveryQueue: Hex[] | null = null;
  private recoveryPasses = 0;
  private readonly limits: AllowanceLimits;
  private readonly allowance: RelayAllowance;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly sender: Sender,
    private readonly fee: { readonly keys: WalletKeys; readonly table: FeeTable } | null,
    private readonly serviceToken: string | null,
  ) {
    this.finalityBlocks = BigInt(intEnv(process.env, "RELAYER_FINALITY_BLOCKS", 64, 1));
    this.rebroadcastMs = intEnv(process.env, "RELAYER_REBROADCAST_MS", 30_000, 1_000);
    this.limits = allowanceLimits(process.env);
    this.allowance = new RelayAllowance(this.limits);
  }

  private view(job: Job): Record<string, unknown> {
    const head = this.ctx.ledger.head;
    return {
      id: job.id, action: job.action, status: job.status, reasonCode: job.reasonCode, tx: job.tx, block: job.block, attempts: job.attempts,
      confirmations: job.block !== null && job.status === "confirmed" && head >= job.block ? head - job.block + 1n : 0n,
      canRetry: job.status === "reorged" || (job.status === "reverted" && ["UNKNOWN_ROOT", "STALE_AS_OF", "RPC_UNAVAILABLE"].includes(job.reasonCode ?? "")),
    };
  }

  private backlog(): number {
    let n = 0;
    for (const job of this.jobs.values()) if (job.status === "pending") n++;
    return n;
  }

  private remember(job: Job): void {
    this.jobs.set(job.id, job);
    if (this.jobs.size <= MAX_JOBS) return;
    for (const [id, j] of this.jobs) {
      if (j.status !== "pending") {
        this.jobs.delete(id);
        if (j.tx) this.byTx.delete(j.tx);
        break;
      }
    }
  }

  private setStatus(job: Job, status: JobStatus, reasonCode: string | null): void {
    job.status = status;
    job.reasonCode = reasonCode;
    job.updatedAt = Date.now();
    this.ctx.bump(`jobs_${status}`);
    if (status !== "pending" && job.call) for (const nf of job.call.nullifiers) if (this.inFlight.get(nf) === job.id) this.inFlight.delete(nf);
    this.ctx.log.info("job_status", { action: job.action, status, reasonCode, tx: job.tx });
  }

  /** Exit bonds fronted and not yet back, counting requests still in flight. */
  private bondsOut(): number {
    let pending = 0;
    for (const job of this.jobs.values()) if (job.action === "requestExit" && job.status === "pending") pending++;
    return pending + frontedBonds(this.ctx.ledger.exits, this.sender.account.address, (nf) => this.ctx.ledger.consumption(nf) !== undefined);
  }

  async submit(action: RelayAction, body: Record<string, unknown>, client: string, presentedToken: string | null = null): Promise<Response> {
    if (!this.recovered) throw new ServiceError(503, "NOT_READY", "The relayer is still recovering jobs from the chain.", true);
    const call = parseRelayRequest(action, body);
    const value = action === "requestExit" ? this.ctx.chain.exitBond : 0n;
    const data = encodeFunctionData({ abi: this.ctx.chain.abi, functionName: call.functionName, args: call.args });
    const id = keccak256(data);
    const existing = this.jobs.get(id);
    if (existing && (existing.status === "pending" || existing.status === "confirmed")) return json(this.view(existing), 200);
    if (retryLimitReached(existing, this.limits.maxRevertedAttempts)) {
      throw new ServiceError(422, "RETRY_LIMIT", "This request already reverted on chain. Prove it again before resending.", false, { lastReason: existing?.reasonCode ?? null });
    }
    const landed = await this.landedAlready(call, id);
    if (landed) return json(this.view(landed), 200);
    for (const nf of call.nullifiers) {
      const holder = this.inFlight.get(nf);
      if (holder && holder !== id) throw new ServiceError(409, "NULLIFIER_IN_FLIGHT", "Another request spending this record is already being submitted.", true);
    }
    if (this.backlog() >= MAX_BACKLOG) throw new ServiceError(503, "QUEUE_FULL", "The relayer is at capacity. Try again shortly.", true);
    if (action === "requestExit" && this.bondsOut() >= this.limits.maxFrontedBonds) {
      throw new ServiceError(503, "EXIT_BOND_CAP", "The relayer has fronted all the exit bonds it can for now. Try again later.", true);
    }
    const { settlement } = settleFee(call, this.fee, this.ctx.chain.deploymentId, serviceTokenValid(presentedToken, this.serviceToken));
    // Charged before any RPC work, so a client out of allowance costs no balance read or simulation. An LP add's two locks
    // cost what two separate locks would, and are refused whole.
    const charge = settlement === "free" ? { action: action === "lockPair" ? ("lock" as const) : action, units: action === "lockPair" ? 2 : 1 } : null;
    if (charge) {
      const spent = this.allowance.charge(charge.action, client, Date.now(), charge.units);
      if (spent) {
        this.ctx.bump("allowanceRefusals");
        throw new ServiceError(429, "RELAY_ALLOWANCE_SPENT", "The relayer's free allowance for this is used up for now. Try again later.", true, { limit: spent });
      }
    }

    let broadcast;
    try {
      broadcast = await this.send(call, value);
    } catch (error) {
      if (charge) this.allowance.refund(charge.action, client, charge.units);
      throw error;
    }
    this.ctx.bump(`fees_${settlement}`);
    const job: Job = existing ?? { id, action, status: "pending", reasonCode: null, tx: null, raw: null, block: null, blockHash: null, attempts: 0, createdAt: Date.now(), updatedAt: Date.now(), call };
    job.attempts += 1;
    job.status = "pending";
    job.reasonCode = null;
    job.tx = broadcast.hash;
    job.raw = broadcast.raw;
    job.call = call;
    job.block = null;
    job.blockHash = null;
    job.updatedAt = Date.now();
    this.remember(job);
    this.byTx.set(broadcast.hash, id);
    for (const nf of call.nullifiers) this.inFlight.set(nf, id);
    this.ctx.bump("jobs_accepted");
    this.ctx.recordAction(`relay:${action}`, broadcast.hash);
    this.ctx.log.info("job_accepted", { action, tx: broadcast.hash, attempt: job.attempts });
    return json(this.view(job), 202);
  }

  /** Checks gas, simulates and broadcasts. Throws when nothing was sent. */
  private async send(call: RelayCall, value: bigint): Promise<Broadcast> {
    if ((await this.sender.balance()) < MIN_GAS_BALANCE + value) throw new ServiceError(503, "INSUFFICIENT_GAS", "The relayer is out of gas funds.", true);
    const refused = await this.sender.simulate(call.functionName, call.args, value);
    if (refused) throw new ServiceError(422, refused.reason === "NULLIFIER_SPENT" ? "NULLIFIER_SPENT" : refused.reason, "The contract would reject this request.", refused.reason === "UNKNOWN_ROOT" || refused.reason === "STALE_AS_OF" || refused.reason === "ORACLE_UNAVAILABLE" || refused.reason === "FUNDING_STALE", refused.name ? { errorName: refused.name } : undefined);
    try {
      return await this.sender.broadcast(call.functionName, call.args, value);
    } catch (error) {
      this.ctx.log.error("broadcast_failed", error, { action: call.action });
      throw new ServiceError(503, "RPC_UNAVAILABLE", "The transaction could not be sent.", true);
    }
  }

  private feeAddressView(): unknown {
    return this.fee ? { auth: this.fee.keys.auth, pk: this.fee.keys.pk } : null;
  }

  /** `quotes` per action and asset (`*` for every action with a fee output); empty when every fee is zero. */
  feeInfo(): Response {
    const quotes = this.fee ? this.fee.table.quotes() : [];
    return json({ address: this.feeAddressView(), quotes, minimums: quotes.filter((q) => q.action === "*" || q.action === "spend").map(({ asset, amount }) => ({ asset, amount })) });
  }

  /** A restarted relayer or a repeated request finds an already-settled job through the chain, not a local store. */
  private async landedAlready(call: RelayCall, id: Hex): Promise<Job | null> {
    for (const nf of call.nullifiers) {
      const consumption = this.ctx.ledger.consumption(nf);
      if (!consumption) continue;
      const tx = await this.ctx.chain.client.getTransaction({ hash: consumption.tx });
      if (keccak256(tx.input) !== id) return null;
      const receipt = await this.sender.receiptOrNull(consumption.tx);
      if (!receipt || receipt.status !== "success") return null;
      const job: Job = { id, action: call.action, status: "confirmed", reasonCode: null, tx: consumption.tx, raw: null, block: receipt.blockNumber, blockHash: receipt.blockHash, attempts: 1, createdAt: Date.now(), updatedAt: Date.now(), call };
      this.remember(job);
      this.byTx.set(consumption.tx, id);
      return job;
    }
    return null;
  }

  status(id: string): Response {
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new ServiceError(400, "INVALID_REQUEST", "job id must be a 32-byte hex string.", false);
    const job = this.jobs.get(id.toLowerCase() as Hex);
    if (!job) throw new ServiceError(404, "JOB_UNKNOWN", "No such job. Send the same request again; it is idempotent.", true);
    return json(this.view(job));
  }

  private async checkPending(job: Job): Promise<void> {
    if (!job.tx) return;
    const receipt = await this.sender.receiptOrNull(job.tx);
    if (!receipt) {
      if (Date.now() - job.updatedAt > this.rebroadcastMs && job.raw) {
        job.updatedAt = Date.now();
        await this.sender.rebroadcast(job.raw).then(
          () => this.ctx.bump("rebroadcasts"),
          (error: unknown) => this.ctx.log.debug("rebroadcast_refused", { message: error instanceof Error ? error.message.slice(0, 120) : "unknown" }),
        );
      }
      return;
    }
    job.block = receipt.blockNumber;
    job.blockHash = receipt.blockHash;
    if (receipt.status === "success") {
      this.setStatus(job, "confirmed", null);
      this.ctx.recordAction(`confirmed:${job.action}`, job.tx);
      return;
    }
    const call = job.call;
    const revert = call
      ? await this.sender.explainRevert(receipt, call.functionName, call.args, call.action === "requestExit" ? this.ctx.chain.exitBond : 0n)
      : { reason: "REVERTED_UNKNOWN" as const, name: null };
    this.setStatus(job, "reverted", revert.reason);
  }

  /** A confirmed job leaves the watch list once deeper than the finality window; until then its block must stay canonical. */
  private async checkConfirmed(job: Job): Promise<void> {
    if (job.block === null || job.tx === null) return;
    const head = this.ctx.ledger.head;
    if (head >= job.block && head - job.block > this.finalityBlocks) return;
    const receipt = await this.sender.receiptOrNull(job.tx);
    if (receipt && receipt.blockHash === job.blockHash) return;
    if (receipt && receipt.status === "success") {
      job.block = receipt.blockNumber;
      job.blockHash = receipt.blockHash;
      this.ctx.log.info("job_reincluded", { action: job.action, tx: job.tx });
      return;
    }
    this.setStatus(job, "reorged", "REORGED");
    if (job.call) for (const nf of job.call.nullifiers) if (this.inFlight.get(nf) === job.id) this.inFlight.delete(nf);
  }

  async tick(): Promise<void> {
    if (!this.recovered) await this.recover();
    let pending = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "pending") {
        await this.checkPending(job);
        if (this.jobs.get(job.id)?.status === "pending") pending++;
      } else if (job.status === "confirmed") {
        await this.checkConfirmed(job);
      } else if (job.status === "reorged" && job.tx) {
        const receipt = await this.sender.receiptOrNull(job.tx);
        if (receipt && receipt.status === "success") {
          job.block = receipt.blockNumber;
          job.blockHash = receipt.blockHash;
          this.setStatus(job, "confirmed", null);
        }
      }
    }
    await this.reclaimBonds();
    this.allowance.prune();
    this.ctx.liveness.backlog = { pendingJobs: pending, bondsFronted: this.bondsOut() };
    this.ctx.liveness.details = { jobsTracked: this.jobs.size };
  }

  /** Rebuilds confirmed jobs from this key's own past transactions. Runs once, after the first ledger sync. */
  /**
   * Rebuilds confirmed jobs from this key's past transactions, so a restart still answers job lookups. A public RPC
   * rate-limits a burst of reads, so it reads a few at a time and retries only the ones that failed. After a few passes
   * the relayer opens anyway: an unrecovered old job only means its status lookup says unknown, never a lost fund.
   */
  private async recover(): Promise<void> {
    this.recoveryQueue ??= [...new Set(this.ctx.ledger.consumptionTxs())];
    const me = this.sender.account.address.toLowerCase();
    const failed: Hex[] = [];
    let restored = 0;
    for (let i = 0; i < this.recoveryQueue.length; i += RECOVERY_BATCH) {
      const batch = this.recoveryQueue.slice(i, i + RECOVERY_BATCH);
      const results = await Promise.allSettled(batch.map(async (hash) => {
        const tx = await this.ctx.chain.client.getTransaction({ hash });
        if (tx.from.toLowerCase() !== me) return false;
        const id = keccak256(tx.input);
        if (this.jobs.has(id)) return false;
        const decoded = decodeFunctionData({ abi: this.ctx.chain.abi, data: tx.input });
        if (!isRelayAction(decoded.functionName)) return false;
        const receipt = await this.sender.receiptOrNull(hash);
        if (!receipt || receipt.status !== "success") return false;
        this.remember({ id, action: decoded.functionName, status: "confirmed", reasonCode: null, tx: hash, raw: null, block: receipt.blockNumber, blockHash: receipt.blockHash, attempts: 1, createdAt: Date.now(), updatedAt: Date.now(), call: null });
        this.byTx.set(hash, id);
        return true;
      }));
      results.forEach((r, j) => {
        if (r.status === "rejected") failed.push(batch[j]!);
        else if (r.value) restored += 1;
      });
    }
    this.recoveryQueue = failed;
    this.recoveryPasses += 1;
    if (failed.length === 0 || this.recoveryPasses >= RECOVERY_PASSES) {
      this.recovered = true;
      this.recoveryQueue = null;
      this.ctx.log.info("jobs_recovered", { restored, unread: failed.length, passes: this.recoveryPasses });
    }
  }

  /** Exit bonds are fronted by this key. Once a pair is gone the bond is reclaimable, so it is reclaimed and withdrawn. */
  private async reclaimBonds(): Promise<void> {
    const me = this.sender.account.address.toLowerCase();
    for (const e of this.ctx.ledger.exits) {
      if (e.requester.toLowerCase() !== me || !this.ctx.ledger.consumption(e.nullifier)) continue;
      const request = await this.ctx.chain.read<readonly [string, bigint]>("exitRequests", [e.nullifier]);
      if (BigInt(request[0]) === 0n) continue;
      const out = await this.sender.send("reclaimExitBond", [e.nullifier]);
      if (out.status === "confirmed") this.ctx.bump("bondsReclaimed");
    }
    const balance = await this.ctx.chain.read<bigint>("bondBalance", [this.sender.account.address]);
    if (balance > 0n) {
      const out = await this.sender.send("withdrawBond", []);
      if (out.status === "confirmed") this.ctx.bump("bondWithdrawals");
    }
  }
}

await runService({
  name: "relayer",
  port: intEnv(process.env, "PORT", PORTS.relayer, 1),
  init(ctx) {
    const sender = new Sender(ctx.chain, takePrivateKey(process.env, "RELAYER_TX_KEY"), ctx.log);
    const feeSeed = process.env.RELAYER_FEE_SEED;
    const table = FeeTable.parse(process.env.RELAYER_MIN_FEES ?? "");
    if (!feeSeed && table.quotes().length > 0) throw new Error("RELAYER_MIN_FEES needs RELAYER_FEE_SEED to open fee notes");
    const relayer = new Relayer(ctx, sender, feeSeed ? { keys: deriveKeys(takeScalar(process.env, "RELAYER_FEE_SEED")), table } : null, process.env.RELAYER_SERVICE_TOKEN || null);
    const routes: Route[] = [
      {
        method: "POST", pattern: "/v1/relay/:action", perMinute: RELAY_PER_MINUTE,
        handler: async ({ req, params, client }) => {
          const action = params.action ?? "";
          if (!isRelayAction(action)) throw new ServiceError(404, "UNKNOWN_ACTION", "Unknown relay action.", false);
          return relayer.submit(action, await readJson(req, MAX_BODY_BYTES), client ?? "unknown", req.headers.get(SERVICE_TOKEN_HEADER));
        },
      },
      { method: "GET", pattern: "/v1/jobs/:id", perMinute: 600, handler: ({ params }) => relayer.status(params.id ?? "") },
      { method: "GET", pattern: "/v1/relayer", perMinute: 600, handler: () => relayer.feeInfo() },
    ];
    return { routes, tick: () => relayer.tick() };
  },
});
