/**
 * Submits wallet-prepared proofs. It sees only what will become public anyway, holds no user secrets and never signs for
 * users. A job's id is the keccak of its calldata, so a retry of the same request is the same job, before and after a
 * restart. Restart recovery comes from the chain: confirmed jobs are rebuilt from this key's own past transactions.
 */
import { deriveKeys, scanCreated, type WalletKeys } from "@rooq/private-sdk";
import { intEnv, PORTS, takePrivateKey, takeScalar } from "../lib/config";
import { json, readJson, type Route } from "../lib/http";
import { isRelayAction, MAX_BODY_BYTES, parseRelayRequest, type RelayAction, type RelayCall } from "../lib/relay-codec";
import { ServiceError } from "../lib/errors";
import { Sender } from "../lib/sender";
import { runService, type ServiceContext } from "../lib/service";
import { encodeFunctionData, isAddress, keccak256, decodeFunctionData, type Hex } from "viem";

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

  constructor(
    private readonly ctx: ServiceContext,
    private readonly sender: Sender,
    private readonly fee: { readonly keys: WalletKeys; readonly minimums: ReadonlyMap<bigint, bigint> } | null,
  ) {
    this.finalityBlocks = BigInt(intEnv(process.env, "RELAYER_FINALITY_BLOCKS", 64, 1));
    this.rebroadcastMs = intEnv(process.env, "RELAYER_REBROADCAST_MS", 30_000, 1_000);
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

  async submit(action: RelayAction, body: Record<string, unknown>): Promise<Response> {
    if (!this.recovered) throw new ServiceError(503, "NOT_READY", "The relayer is still recovering jobs from the chain.", true);
    const call = parseRelayRequest(action, body);
    const value = action === "requestExit" ? this.ctx.chain.exitBond : 0n;
    const data = encodeFunctionData({ abi: this.ctx.chain.abi, functionName: call.functionName, args: call.args });
    const id = keccak256(data);
    const existing = this.jobs.get(id);
    if (existing && (existing.status === "pending" || existing.status === "confirmed")) return json(this.view(existing), 200);
    const landed = await this.landedAlready(call, id);
    if (landed) return json(this.view(landed), 200);
    for (const nf of call.nullifiers) {
      const holder = this.inFlight.get(nf);
      if (holder && holder !== id) throw new ServiceError(409, "NULLIFIER_IN_FLIGHT", "Another request spending this record is already being submitted.", true);
    }
    if (this.backlog() >= MAX_BACKLOG) throw new ServiceError(503, "QUEUE_FULL", "The relayer is at capacity. Try again shortly.", true);
    if ((await this.sender.balance()) < MIN_GAS_BALANCE + value) throw new ServiceError(503, "INSUFFICIENT_GAS", "The relayer is out of gas funds.", true);

    if (action === "spend") this.requireFeeNote(call);
    const refused = await this.sender.simulate(call.functionName, call.args, value);
    if (refused) throw new ServiceError(422, refused.reason === "NULLIFIER_SPENT" ? "NULLIFIER_SPENT" : refused.reason, "The contract would reject this request.", refused.reason === "UNKNOWN_ROOT" || refused.reason === "STALE_AS_OF" || refused.reason === "ORACLE_UNAVAILABLE" || refused.reason === "FUNDING_STALE", refused.name ? { errorName: refused.name } : undefined);

    let broadcast;
    try {
      broadcast = await this.sender.broadcast(call.functionName, call.args, value);
    } catch (error) {
      this.ctx.log.error("broadcast_failed", error, { action });
      throw new ServiceError(503, "RPC_UNAVAILABLE", "The transaction could not be sent.", true);
    }
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

  /**
   * D-05: the spend's third output must be a note this relayer can open, worth at least the configured fee for its asset.
   * The asset and amount stay hidden from everyone else, and the proof fixes the note, so reading it here is enough.
   */
  private requireFeeNote(call: RelayCall): void {
    if (!this.fee || this.fee.minimums.size === 0) return;
    const inputs = call.args[1] as { commitments: readonly Hex[]; ciphertexts: readonly (readonly Hex[])[] };
    const note = scanCreated(this.fee.keys, this.ctx.chain.deploymentId, [{ firstLeafIndex: 0, commitments: [BigInt(inputs.commitments[2]!)], ciphertexts: [inputs.ciphertexts[2]!.map(BigInt)] }])[0];
    if (!note) throw new ServiceError(402, "RELAYER_FEE_REQUIRED", "The third spend output must be a fee note to this relayer's address.", false, { feeAddress: this.feeAddressView() });
    const minimum = this.fee.minimums.get(note.asset);
    if (minimum === undefined) throw new ServiceError(402, "RELAYER_FEE_ASSET", "This relayer does not take fees in that asset.", false);
    if (note.value < minimum) throw new ServiceError(402, "RELAYER_FEE_TOO_LOW", "The fee note is below this relayer's minimum.", false);
    this.ctx.bump("feeNotesAccepted");
  }

  private feeAddressView(): unknown {
    return this.fee ? { auth: this.fee.keys.auth, pk: this.fee.keys.pk } : null;
  }

  feeInfo(): Response {
    return json({ address: this.feeAddressView(), minimums: this.fee ? [...this.fee.minimums].map(([asset, amount]) => ({ asset: `0x${asset.toString(16).padStart(40, "0")}`, amount })) : [] });
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
    this.ctx.liveness.backlog = { pendingJobs: pending };
    this.ctx.liveness.details = { jobsTracked: this.jobs.size };
  }

  /** Rebuilds confirmed jobs from this key's own past transactions. Runs once, after the first ledger sync. */
  private async recover(): Promise<void> {
    const txs = this.ctx.ledger.consumptionTxs();
    const me = this.sender.account.address.toLowerCase();
    let restored = 0;
    for (let i = 0; i < txs.length; i += 16) {
      const batch = txs.slice(i, i + 16);
      await Promise.all(batch.map(async (hash) => {
        const tx = await this.ctx.chain.client.getTransaction({ hash });
        if (tx.from.toLowerCase() !== me) return;
        const id = keccak256(tx.input);
        if (this.jobs.has(id)) return;
        const decoded = decodeFunctionData({ abi: this.ctx.chain.abi, data: tx.input });
        if (!isRelayAction(decoded.functionName)) return;
        const receipt = await this.sender.receiptOrNull(hash);
        if (!receipt || receipt.status !== "success") return;
        this.remember({ id, action: decoded.functionName, status: "confirmed", reasonCode: null, tx: hash, raw: null, block: receipt.blockNumber, blockHash: receipt.blockHash, attempts: 1, createdAt: Date.now(), updatedAt: Date.now(), call: null });
        this.byTx.set(hash, id);
        restored += 1;
      }));
    }
    this.recovered = true;
    this.ctx.log.info("jobs_recovered", { restored });
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

function parseMinimums(raw: string): Map<bigint, bigint> {
  const out = new Map<bigint, bigint>();
  for (const part of raw.split(",").map((p) => p.trim()).filter((p) => p !== "")) {
    const [asset, amount] = part.split(":");
    if (!asset || !amount || !isAddress(asset) || !/^\d+$/.test(amount)) throw new Error("RELAYER_MIN_FEES entries are asset:amount");
    out.set(BigInt(asset), BigInt(amount));
  }
  return out;
}

await runService({
  name: "relayer",
  port: intEnv(process.env, "PORT", PORTS.relayer, 1),
  init(ctx) {
    const sender = new Sender(ctx.chain, takePrivateKey(process.env, "RELAYER_TX_KEY"), ctx.log);
    const feeSeed = process.env.RELAYER_FEE_SEED;
    const relayer = new Relayer(ctx, sender, feeSeed ? { keys: deriveKeys(takeScalar(process.env, "RELAYER_FEE_SEED")), minimums: parseMinimums(process.env.RELAYER_MIN_FEES ?? "") } : null);
    const routes: Route[] = [
      {
        method: "POST", pattern: "/v1/relay/:action", perMinute: RELAY_PER_MINUTE,
        handler: async ({ req, params }) => {
          const action = params.action ?? "";
          if (!isRelayAction(action)) throw new ServiceError(404, "UNKNOWN_ACTION", "Unknown relay action.", false);
          return relayer.submit(action, await readJson(req, MAX_BODY_BYTES));
        },
      },
      { method: "GET", pattern: "/v1/jobs/:id", perMinute: 600, handler: ({ params }) => relayer.status(params.id ?? "") },
      { method: "GET", pattern: "/v1/relayer", perMinute: 600, handler: () => relayer.feeInfo() },
    ];
    return { routes, tick: () => relayer.tick() };
  },
});
