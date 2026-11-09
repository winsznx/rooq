import {
  ACTOR_MAKER, ACTOR_TAKER, addressOf, CLOSE_TAKER, closeWitness, depositOpening, exitRequestWitness, lockCommitment, lockWitness, lpSetWitness, lpTerms, makerTerms, noteInner, outputRho, randomField, redeemWitness, releaseWitness, spendWitness, swapTerms,
  takerTerms, toHex32, updateWitness, type InputMap, type LockTerms, type Proof, type PrivateAddress,
} from "@rooq/private-sdk";
import type { Hex } from "viem";
import { ChainState, RelayRefused, ServiceDown } from "./chain-state";
import { decodeAddress } from "./address";
import { prove, ProofFailed, type WalletCircuit } from "./prover";
import { buildView, largestPair, Scanner, selectNotes, type Decoded, type HeldNote, type HeldPosition } from "./scanner";
import type { Intent, OpIcon, PrivateOp, PrivateView, StartOp } from "./types";
import type { OperationKind, OperationStage, OperationStep } from "@/lib/operations";

/** A failure with a name the page can show. Anything else is a bug and also surfaces as a named INTERNAL failure. */
export class Named extends Error {
  constructor(readonly reason: string, message: string, readonly retry = true) {
    super(message);
  }
}

interface Part {
  readonly action: string;
  readonly body: string;
  jobId: Hex | null;
  done: boolean;
  tx: Hex | null;
}

interface OpRecord extends PrivateOp {
  readonly intent: Intent;
  parts: Part[];
  /** Assigned at first prepare and kept across retries, so a retry reuses the same one-time address and terms. */
  data: { payoutIndex?: number; expiryAt?: bigint; link?: bigint; lockIds?: Hex[]; reserves?: string[]; selfTx?: Hex };
}

const RETRY_REASONS = new Set(["INVALID_PROOF", "UNKNOWN_ROOT", "STALE_AS_OF", "NULLIFIER_SPENT", "NULLIFIER_IN_FLIGHT"]);
const MAX_ATTEMPTS = 3;
const RELAYER_DOWN: ReadonlySet<string> = new Set(["RELAYER_UNAVAILABLE", "QUEUE_FULL", "INSUFFICIENT_GAS", "RPC_UNAVAILABLE", "NOT_READY", "TX_TIMEOUT"]);
const NOT_IN_TREE_WAIT_MS = 180_000;
const ACTIVE: ReadonlySet<OperationStage> = new Set(["checking", "awaiting_signature", "preparing_proof", "queued", "submitted", "included", "waiting", "rechecking"]);

const REASON_COPY: Record<string, string> = {
  NULLIFIER_SPENT: "Those funds were already used by another operation.",
  NULLIFIER_IN_FLIGHT: "Another request using those funds is already being sent.",
  INVALID_PROOF: "Rooq's operator keys or the chain changed while this was being prepared, so it wasn't accepted. Retry to rebuild it.",
  UNKNOWN_ROOT: "The private tree moved past the point this proof used.",
  STALE_AS_OF: "This proof's time window passed before it landed.",
  QUEUE_FULL: "The relayer is at capacity. Try again shortly.",
  INSUFFICIENT_GAS: "The relayer is out of gas funds, so it can't send this now.",
  RPC_UNAVAILABLE: "The relayer can't reach the network right now.",
  NOT_READY: "The relayer is still starting up.",
  RELAYER_FEE_REQUIRED: "The relayer needs a fee note on this transfer.",
  RELAYER_FEE_ASSET: "The relayer doesn't take fees in this asset.",
  RELAYER_FEE_TOO_LOW: "The fee is below the relayer's minimum.",
  ORACLE_STALE: "The market price is out of date, so this can't be priced right now.",
};

const describe = (reason: string, fallback: string): string => REASON_COPY[reason] ?? fallback;

function stepsFor(intent: Intent): OperationStep[] {
  const prove: OperationStep = { label: "Prove on this device", stage: "not_started" };
  const send: OperationStep = { label: "Send through the relayer", stage: "not_started" };
  const land: OperationStep = { label: "Wait for a block", stage: "not_started" };
  const extra = (label: string): OperationStep => ({ label, stage: "not_started" });
  switch (intent.t) {
    case "perpOpen": return [prove, send, land, extra("Wait for a maker match")];
    case "makerLock": return [prove, send, land, extra("Enter the private tree")];
    case "swap": return [prove, send, land, extra("Wait for the fill")];
    case "lpAdd": return [prove, send, land, extra("Wait for the pool to take it")];
    case "lpRequest": return [prove, send, land];
    case "unshield": return intent.direct ? [prove, { label: "Sign with your wallet", stage: "not_started" }, land] : [prove, send, land];
    default: return [prove, send, land];
  }
}

function iconsOf(intent: Intent, chain: ChainState): OpIcon[] {
  const pool = (id: bigint): OpIcon[] => {
    const p = chain.pools.find((x) => x.id === id);
    return p ? [{ asset: p.token0 }, { asset: p.token1 }] : [];
  };
  switch (intent.t) {
    case "unshield": case "transfer": case "combine": return [{ asset: intent.asset }];
    case "perpOpen": case "makerLock": return [{ market: intent.market }];
    case "swap": return [{ asset: intent.assetIn }, ...(chain.pools.find((p) => p.id === (intent.secondPool !== 0n ? intent.secondPool : intent.pool)) ? [{ asset: (() => { const p = chain.pools.find((x) => x.id === (intent.secondPool !== 0n ? intent.secondPool : intent.pool))!; return p.token1.toLowerCase() === intent.assetIn.toLowerCase() ? p.token0 : p.token1; })() }] : [])];
    case "lpAdd": return pool(intent.pool);
    default: return [];
  }
}

function kindOf(intent: Intent): OperationKind {
  switch (intent.t) {
    case "unshield": case "transfer": case "combine": case "redeem": case "release": return "funds";
    case "makerLock": return "maker";
    case "lpAdd": case "lpRequest": case "lpRecover": return "liquidity";
    default: return "trade";
  }
}

export class Engine {
  decoded: Decoded | null = null;
  ops: OpRecord[] = [];
  private readonly running = new Set<string>();
  private reservedDeposits = new Set<number>();
  private lastSyncError: string | null = null;
  view: PrivateView | null = null;
  private stopped = false;

  constructor(
    readonly chain: ChainState,
    private readonly scanner: Scanner,
    private readonly address: string,
    private readonly persist: (ops: readonly unknown[]) => void,
    private readonly emit: (view: PrivateView | null, ops: readonly PrivateOp[]) => void,
  ) {}

  publicOps(): PrivateOp[] {
    return this.ops.map((o) => {
      const { intent: _i, parts: _p, data: _d, ...rest } = o;
      return rest;
    });
  }

  /** Called on lock. Anything still running stops writing, and the next unlock reconciles it from the chain. */
  stop(): void {
    this.stopped = true;
  }

  private publish(): void {
    if (!this.stopped) this.emit(this.view, this.publicOps());
  }

  private save(): void {
    if (this.stopped) return;
    this.persist(this.ops);
    this.publish();
  }

  private update(id: string, patch: Partial<OpRecord>): OpRecord {
    const idx = this.ops.findIndex((o) => o.id === id);
    const next: OpRecord = { ...this.ops[idx]!, ...patch, updatedAt: Date.now() };
    this.ops[idx] = next;
    this.save();
    return next;
  }

  private step(id: string, index: number, stage: OperationStep["stage"], hash?: Hex): void {
    const op = this.ops.find((o) => o.id === id)!;
    this.update(id, { steps: op.steps.map((s, i) => (i === index ? { ...s, stage, hash: hash ?? s.hash } : i < index && s.stage !== "confirmed" ? { ...s, stage: "confirmed" as const } : s)) });
  }

  // ---------- sync

  async syncOnce(): Promise<void> {
    try {
      await this.chain.sync();
      this.decoded = this.scanner.decode(this.chain);
      for (const k of this.reservedDeposits) if (k < this.decoded.nextDeposit) this.reservedDeposits.delete(k);
      this.lastSyncError = null;
      this.view = buildView(this.chain, this.decoded, this.address, { error: null });
      await this.refreshClaims();
      this.settleWaiting();
    } catch (error) {
      this.lastSyncError = error instanceof ServiceDown ? error.service === "rpc" ? "NETWORK_UNREACHABLE" : error.detail === "ROOT_MISMATCH" ? "ROOT_MISMATCH" : `${error.service.toUpperCase()}_UNAVAILABLE` : "SYNC_FAILED";
      console.warn("rooq: sync failed", error);
      if (this.view) {
        this.view = { ...this.view, sync: { ...this.view.sync, error: this.lastSyncError }, health: { readApi: this.lastSyncError !== "READ_UNAVAILABLE", relayer: this.lastSyncError !== "RELAYER_UNAVAILABLE", rpc: this.lastSyncError !== "NETWORK_UNREACHABLE" } };
      }
      this.publish();
      return;
    }
    this.publish();
  }

  private async refreshClaims(): Promise<void> {
    if (!this.view || !this.decoded) return;
    const claims = await Promise.all(this.view.claims.map(async (c) => {
      if (c.status !== "waiting") return c;
      const held = this.decoded!.claims.find((x) => toHex32(x.commitment) === c.id);
      if (!held) return c;
      const ratio = await this.chain.foldedRatio(toHex32(held.record.deltaCm));
      return ratio === null ? c : { ...c, status: "redeemable" as const, ratio };
    }));
    this.view = { ...this.view, claims };
  }

  get syncError(): string | null {
    return this.lastSyncError;
  }

  hasActive(): boolean {
    return this.ops.some((o) => ACTIVE.has(o.stage));
  }

  // ---------- deposits

  prepareShield(): { inner: Hex; depositIndex: number } {
    if (!this.decoded) throw new Named("NOT_SYNCED", "Your private account hasn't finished reading the chain yet.");
    let k = this.decoded.nextDeposit;
    while (this.reservedDeposits.has(k)) k++;
    this.reservedDeposits.add(k);
    const { rho, blind } = depositOpening(this.scanner.seed, k);
    return { inner: toHex32(noteInner(this.scanner.main.owner, rho, blind)), depositIndex: k };
  }

  /** A sent deposit keeps its index reserved until the chain shows it, so a second shield can't reuse the opening. */
  shieldFinished(k: number, ok: boolean): void {
    if (!ok) this.reservedDeposits.delete(k);
    void this.syncOnce();
  }

  // ---------- operations

  async start(op: StartOp): Promise<string> {
    const now = Date.now();
    const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.ops.unshift({
      id, icons: iconsOf(op.intent, this.chain), kind: kindOf(op.intent), title: op.title, href: op.href, createdAt: now, updatedAt: now, stage: "preparing_proof", steps: stepsFor(op.intent), quoteExpiresAt: null, finalityNote: null, message: null, reason: null,
      canRetry: false, canCancel: true, dismissed: false, walletCall: null, offerDirect: false, intent: op.intent, parts: [], data: {},
    });
    this.ops = this.ops.slice(0, 40);
    this.save();
    void this.drive(id);
    return id;
  }

  retry(id: string): void {
    const op = this.ops.find((o) => o.id === id);
    if (!op || this.running.has(id)) return;
    this.update(id, { stage: "preparing_proof", message: null, reason: null, canRetry: false, canCancel: true, steps: stepsFor(op.intent), walletCall: null, offerDirect: false });
    void this.drive(id);
  }

  cancel(id: string): void {
    const op = this.ops.find((o) => o.id === id);
    if (!op || op.parts.some((p) => p.jobId)) return;
    this.update(id, { stage: "cancelled", canCancel: false, canRetry: false, message: "Stopped before anything was sent." });
  }

  dismiss(id: string): void {
    const op = this.ops.find((o) => o.id === id);
    if (op) this.update(id, { dismissed: true });
  }

  /** On unlock: anything with a submitted proof continues; a proof that died with the page needs a click, since time has passed. */
  resume(): void {
    for (const op of this.ops) {
      if (op.stage === "waiting" || op.stage === "included" || op.stage === "submitted" || op.stage === "queued" || op.stage === "rechecking") {
        if (op.parts.length > 0) void this.drive(op.id);
        else this.interrupted(op.id);
      } else if (op.stage === "preparing_proof" || op.stage === "checking") {
        this.interrupted(op.id);
      } else if (op.stage === "awaiting_signature") {
        this.update(op.id, { stage: "failed", canRetry: true, canCancel: false, reason: "WALLET_INTERRUPTED", walletCall: null, message: "The page closed before your wallet answered. Check your wallet's history, then try again." });
      }
    }
  }

  /** The emergency exit is offered only for a plain withdrawal the relayer couldn't take. */
  private mayGoDirect(op: OpRecord, reason: string): boolean {
    return op.intent.t === "unshield" && !op.intent.direct && RELAYER_DOWN.has(reason);
  }

  private interrupted(id: string): void {
    this.update(id, { stage: "recovery_required", reason: "INTERRUPTED", canRetry: true, canCancel: true, message: "The page closed while this proof was being built. Nothing was sent. Resume to prove it again at current prices." });
  }

  private async drive(id: string): Promise<void> {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      await this.runOp(id);
    } catch (error) {
      this.failFrom(id, error);
    } finally {
      this.running.delete(id);
    }
  }

  private failFrom(id: string, error: unknown): void {
    const op = this.ops.find((o) => o.id === id)!;
    const sent = op.parts.some((p) => p.jobId);
    if (error instanceof Named) {
      this.update(id, { stage: "failed", reason: error.reason, canRetry: error.retry, canCancel: false, message: error.message });
    } else if (error instanceof RelayRefused) {
      this.update(id, { stage: "failed", reason: error.reason, canRetry: !sent, canCancel: false, message: describe(error.reason, error.message), offerDirect: this.mayGoDirect(op, error.reason) });
    } else if (error instanceof ServiceDown) {
      const reason = error.service === "relayer" ? "RELAYER_UNAVAILABLE" : error.service === "read" ? "READ_UNAVAILABLE" : "NETWORK_UNREACHABLE";
      this.update(id, sent
        ? { stage: "rechecking", reason, message: "The service can't be reached. Rooq will keep checking this submitted proof." }
        : { stage: "failed", reason, canRetry: true, canCancel: false, message: `${error.service === "relayer" ? "The relayer" : error.service === "read" ? "The private read service" : "The network"} can't be reached, so this was not sent. Nothing fell back to a public path.`, offerDirect: this.mayGoDirect(op, reason) });
    } else if (error instanceof ProofFailed) {
      this.update(id, { stage: "failed", reason: error.reason, canRetry: true, canCancel: false, message: error.reason === "PROOF_TIMEOUT" ? error.message : `The proof refused these inputs: ${error.message.replace(/^.*?:/, "").trim().slice(0, 160)}` });
    } else {
      console.error("rooq: operation failed", error);
      this.update(id, { stage: "failed", reason: "INTERNAL", canRetry: true, canCancel: false, message: "Rooq hit an unexpected error preparing this. Nothing was sent." });
    }
  }

  /** Reserved notes across this wallet's other in-flight operations. */
  private reservedNullifiers(exclude: string): Set<string> {
    const out = new Set<string>();
    for (const o of this.ops) if (o.id !== exclude && ACTIVE.has(o.stage)) for (const r of o.data.reserves ?? []) out.add(r);
    return out;
  }

  private nextPayout(id: string): number {
    const taken = this.ops.filter((o) => o.id !== id && ACTIVE.has(o.stage)).map((o) => o.data.payoutIndex ?? -1);
    return Math.max(this.decoded!.nextAddress, ...taken.map((i) => i + 1));
  }

  private async runOp(id: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      let op = this.ops.find((o) => o.id === id)!;
      if (op.stage === "cancelled") return;
      if (op.parts.length === 0) {
        this.update(id, { stage: "preparing_proof", message: null });
        this.step(id, 0, "preparing_proof");
        await this.prepareWhenReady(id);
        op = this.ops.find((o) => o.id === id)!;
        if (op.stage === "cancelled") return;
        this.step(id, 1, "not_started");
      }
      try {
        if (op.intent.t === "unshield" && op.intent.direct) {
          await this.selfSubmit(id);
          return;
        }
        await this.sendParts(id);
        break;
      } catch (error) {
        const reason = error instanceof RelayRefused ? error.reason : error instanceof Named ? error.reason : "";
        if (RETRY_REASONS.has(reason) && attempt < MAX_ATTEMPTS) {
          this.update(id, { parts: [], message: "The chain moved. Rooq is rebuilding the proof at current state." });
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        if (reason === "INVALID_PROOF") {
          this.update(id, { parts: [] });
          throw new Named(reason, describe(reason, ""), true);
        }
        throw error;
      }
    }
    await this.settle(id);
  }

  /** New records take a moment to enter the tree. That isn't a failure, so wait for it, in the open, up to a limit. */
  private async prepareWhenReady(id: string): Promise<void> {
    const deadline = Date.now() + NOT_IN_TREE_WAIT_MS;
    for (;;) {
      await this.chain.sync();
      this.decoded = this.scanner.decode(this.chain);
      try {
        await navigator.locks.request("rooq-spend", async () => this.prepare(id));
        return;
      } catch (error) {
        if (!(error instanceof Named) || error.reason !== "NOT_IN_TREE" || Date.now() > deadline) throw error;
        this.update(id, { message: error.message });
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  private async sendParts(id: string): Promise<void> {
    let op = this.ops.find((o) => o.id === id)!;
    for (const [i, part] of op.parts.entries()) {
      if (part.done) continue;
      if (!part.jobId) {
        this.update(id, { stage: "queued", canCancel: false, message: "Sending your proof through the relayer." });
        this.step(id, 1, "queued");
        const { id: jobId } = await this.chain.relaySend(part.action, part.body);
        op.parts[i] = { ...part, jobId };
        this.update(id, { parts: op.parts });
      }
      this.update(id, { stage: "submitted", message: "Waiting for the transaction to land in a block." });
      this.step(id, 2, "submitted");
      await this.pollJob(id, i);
      op = this.ops.find((o) => o.id === id)!;
    }
  }

  private async pollJob(id: string, i: number): Promise<void> {
    const op = this.ops.find((o) => o.id === id)!;
    const part = op.parts[i]!;
    const started = Date.now();
    for (;;) {
      if (this.stopped) throw new Named("LOCKED", "The account locked while this was running.", false);
      let job;
      try {
        job = await this.chain.relayJob(part.jobId!);
      } catch (error) {
        if (error instanceof ServiceDown) {
          this.update(id, { stage: "rechecking", reason: "RELAYER_UNAVAILABLE", message: "The relayer isn't answering. Your proof was accepted, so Rooq keeps checking." });
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        throw error;
      }
      if (job === null) {
        await this.chain.relaySend(part.action, part.body);
      } else if (job.status === "confirmed") {
        part.done = true;
        part.tx = job.tx;
        this.update(id, { stage: "included", parts: op.parts, reason: null, message: null });
        this.step(id, 2, "confirmed", job.tx ?? undefined);
        return;
      } else if (job.status === "reverted") {
        throw new Named(job.reasonCode ?? "REVERTED", describe(job.reasonCode ?? "", `The contract rejected this: ${job.reasonCode ?? "unknown reason"}.`), job.canRetry);
      } else if (job.status === "reorged") {
        this.update(id, { stage: "rechecking", reason: "REORGED", message: "The block holding this was replaced. Rooq is re-sending the same proof." });
        await this.chain.relaySend(part.action, part.body);
      }
      if (Date.now() - started > 600_000) throw new Named("TX_TIMEOUT", "This has been waiting for a block for ten minutes. Check the relayer status and retry.", true);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  /** The person chose to pay gas from their own wallet, after being told that links it to this withdrawal. */
  goDirect(id: string): void {
    const op = this.ops.find((o) => o.id === id);
    if (!op || op.intent.t !== "unshield" || this.running.has(id)) return;
    const intent: Intent = { ...op.intent, direct: true };
    const idx = this.ops.findIndex((o) => o.id === id);
    this.ops[idx] = { ...op, intent, parts: [], data: {} };
    this.update(id, { stage: "preparing_proof", steps: stepsFor(intent), message: null, reason: null, canRetry: false, canCancel: true, offerDirect: false, walletCall: null });
    void this.drive(id);
  }

  private async selfSubmit(id: string): Promise<void> {
    const op = this.ops.find((o) => o.id === id)!;
    const part = op.parts[0]!;
    if (op.data.selfTx) {
      await this.waitReceipt(id, op.data.selfTx);
      return;
    }
    const parsed = JSON.parse(part.body) as { proof: Hex; publicInputs: unknown };
    this.update(id, { stage: "awaiting_signature", canCancel: false, walletCall: { functionName: "spend", proof: parsed.proof, publicInputs: parsed.publicInputs }, message: "Your wallet will send this. It pays the gas, and that links it to this withdrawal." });
    this.step(id, 1, "awaiting_signature");
  }

  walletTxSent(id: string, hash: Hex): void {
    const op = this.ops.find((o) => o.id === id);
    if (!op) return;
    this.update(id, { stage: "submitted", walletCall: null, message: "Waiting for the transaction to land in a block.", data: { ...op.data, selfTx: hash } });
    this.step(id, 2, "submitted", hash);
    void this.waitReceipt(id, hash).catch((error: unknown) => this.failFrom(id, error));
  }

  walletTxFailed(id: string, reason: string, message: string): void {
    this.update(id, { stage: reason === "USER_REJECTED" ? "rejected" : "failed", reason, canRetry: true, canCancel: false, message, walletCall: null });
  }

  private async waitReceipt(id: string, hash: Hex): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const r = await this.chain.receipt(hash);
      if (r) {
        if (r.status === "success") {
          this.step(id, 2, "confirmed", hash);
          this.update(id, { stage: "confirmed", message: null, reason: null });
          void this.syncOnce();
        } else {
          this.update(id, { stage: "failed", reason: "REVERTED", canRetry: true, canCancel: false, message: "The contract rejected the transaction your wallet sent." });
        }
        return;
      }
      await new Promise((res) => setTimeout(res, 1500));
    }
    this.update(id, { stage: "recovery_required", reason: "NO_RECEIPT", canRetry: false, message: "No receipt after ten minutes. Check your wallet's history before retrying." });
  }

  private async settle(id: string): Promise<void> {
    const op = this.ops.find((o) => o.id === id)!;
    if (!this.needsWait(op)) {
      this.update(id, { stage: "confirmed", message: null, reason: null });
      await this.syncOnce();
      return;
    }
    this.update(id, { stage: "waiting", message: this.waitingMessage(op), reason: null });
    this.step(id, 3, "waiting");
    await this.syncOnce();
  }

  private needsWait(op: OpRecord): boolean {
    return op.intent.t === "perpOpen" || op.intent.t === "swap" || op.intent.t === "lpAdd" || op.intent.t === "makerLock";
  }

  private waitingMessage(op: OpRecord): string {
    if (op.intent.t === "perpOpen") return "Your funds are locked and waiting for a maker match. A match isn't guaranteed.";
    if (op.intent.t === "swap") return "Your funds are locked and waiting for the operator to fill them.";
    if (op.intent.t === "lpAdd") return "Your funds are locked and waiting for the pool to take them.";
    return "Your backing is entering the private tree.";
  }

  /** Runs after each sync. Terminal states come only from what the chain says, never from a timer in this page. */
  private settleWaiting(): void {
    const d = this.decoded;
    const view = this.view;
    if (!d || !view) return;
    const now = this.chain.chainNow ?? 0n;
    for (const op of this.ops) {
      if (op.stage !== "waiting") continue;
      const i = op.intent;
      const locks = d.locks.filter((l) => (op.data.lockIds ?? []).includes(toHex32(l.commitment)));
      const lockExpired = op.data.expiryAt !== undefined && now > op.data.expiryAt;
      // Spent status comes from RPC logs, records from the read API. Only trust "spent" once the read API has caught up to it.
      const spent = locks.length > 0 && locks.every((l) => {
        const at = this.chain.spent.get(toHex32(l.nullifier));
        return at !== undefined && this.chain.syncedBlock !== null && this.chain.syncedBlock >= at.block;
      });
      if (i.t === "makerLock") {
        if (locks.length > 0 && locks.every((l) => l.leafIndex < this.chain.processed)) this.done(op.id, 3);
      } else if (i.t === "perpOpen") {
        if (d.positions.some((p) => p.keyIndex === op.data.payoutIndex)) this.done(op.id, 3);
        else if (spent) this.expired(op.id, "This lock came back without a match. The funds are in your private balance.");
        else if (lockExpired) this.expired(op.id, "No maker matched before this lock expired. Release it from Trade to get your funds back.");
      } else if (i.t === "swap") {
        if (spent) {
          const out = d.allNotesByRho.get(outputRho(locks[0]!.nullifier, 0n, 0));
          if (out && out.asset !== BigInt(i.assetIn)) this.done(op.id, 3);
          else this.expired(op.id, "This swap wasn't filled. The funds came back to your private balance.");
        } else if (lockExpired) {
          this.expired(op.id, "This swap wasn't filled before it expired. Refund it from Swap.");
        }
      } else if (i.t === "lpAdd") {
        if (d.lps.some((l) => l.keys.pk.x === this.scanner.address(op.data.payoutIndex!).pk.x)) this.done(op.id, 3);
        else if (lockExpired) this.expired(op.id, "The pool didn't take this before it expired. Release the locks from Liquidity.");
      }
    }
  }

  private done(id: string, step: number): void {
    this.step(id, step, "confirmed");
    this.update(id, { stage: "confirmed", message: null, reason: null });
  }

  private expired(id: string, message: string): void {
    this.update(id, { stage: "expired", message, reason: "EXPIRED", canRetry: false });
  }

  // ---------- proof construction

  private market(id: bigint) {
    const m = this.chain.markets.find((x) => x.id === id);
    if (!m) throw new Named("UNKNOWN_MARKET", "This market isn't in the current deployment.", false);
    return m;
  }

  private selectOrThrow(id: string, asset: Hex, amount: bigint): readonly HeldNote[] {
    const picked = selectNotes(this.decoded!.notes, BigInt(asset), amount, this.chain.processed, this.reservedNullifiers(id));
    if (picked) return picked;
    const free = this.decoded!.notes.filter((n) => n.asset === BigInt(asset) && n.leafIndex < this.chain.processed).reduce((s, n) => s + n.value, 0n);
    const arriving = this.decoded!.notes.filter((n) => n.asset === BigInt(asset) && n.leafIndex >= this.chain.processed).reduce((s, n) => s + n.value, 0n);
    if (free < amount && free + arriving >= amount) throw new Named("NOT_IN_TREE", "Waiting for your funds to enter the private tree.");
    if (free >= amount) throw new Named("FRAGMENTED", "Your balance is split across too many notes for one proof. Combine them in Funds, then try again.", false);
    throw new Named("INSUFFICIENT_PRIVATE_BALANCE", "Your private balance doesn't cover this.", false);
  }

  private lockExpiry(op: OpRecord, seconds: bigint): bigint {
    if (op.data.expiryAt === undefined) op.data.expiryAt = (this.chain.chainNow ?? 0n) + seconds;
    return op.data.expiryAt;
  }

  private async buildLock(note: readonly HeldNote[], asset: Hex, amount: bigint, terms: LockTerms, expiry: bigint, payoutIndex: number) {
    const dep = this.chain.deployment!;
    const { coordinator, riskKeys } = await this.chain.readOperatorKeys();
    return lockWitness({ keys: note[0]!.keys, deployment: dep.id, tree: this.chain.tree, asset: BigInt(asset), inputs: note, amount, terms, expiry, coordinator, riskKeys, payout: addressOf(this.scanner.address(payoutIndex)), view: this.scanner.main.pk });
  }

  private async proveTo(id: string, action: string, circuit: WalletCircuit, inputs: InputMap, publicInputs: unknown, index: number): Promise<Part> {
    const op = this.ops.find((o) => o.id === id)!;
    const t0 = performance.now();
    this.update(id, { message: op.intent.t === "lpAdd" ? `Proving lock ${index + 1} of 2 on this device. Your keys stay here.` : "Proving on this device. Your keys stay here." });
    const p: Proof = await prove(circuit, inputs);
    console.info(`rooq: ${circuit} proved in ${Math.round(performance.now() - t0)} ms`);
    return { action, jobId: null, done: false, tx: null, body: JSON.stringify({ proof: bytesToHex(p.proof), publicInputs }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) };
  }

  private position(id: string): HeldPosition {
    const p = this.decoded!.positions.find((x) => x.id === id);
    if (!p) throw new Named("UNKNOWN_POSITION", "This position wasn't found in your account.", false);
    this.requireInTree(p.versions.at(-1)!.leafIndex);
    return p;
  }

  private requireInTree(leafIndex: number): void {
    if (leafIndex >= this.chain.processed) throw new Named("NOT_IN_TREE", "Waiting for this record to enter the private tree.");
  }

  private spendParts(notes: readonly HeldNote[], asset: Hex, outputs: { value: bigint; to: PrivateAddress }[], withdraw?: { amount: bigint; recipient: bigint }): { inputs: InputMap; publicInputs: unknown } {
    const dep = this.chain.deployment!;
    const w = spendWitness({ keys: notes[0]!.keys, deployment: dep.id, tree: this.chain.tree, asset: BigInt(asset), inputs: notes, outputs, withdraw });
    return { inputs: w.inputs, publicInputs: w.publicInputs };
  }

  private async prepare(id: string): Promise<void> {
    const op = this.ops.find((o) => o.id === id)!;
    const i = op.intent;
    const dep = this.chain.deployment!;
    const tree = this.chain.tree;
    const main = this.scanner.main;
    const parts: Part[] = [];
    const now = this.chain.chainNow ?? 0n;
    const relayerFeeNote = (asset: Hex, fee: bigint): { value: bigint; to: PrivateAddress } | null => {
      const addr = this.chain.relayerFeeAddress;
      if (!addr || fee === 0n) return null;
      const min = this.chain.relayerFees.find((f) => f.asset.toLowerCase() === asset.toLowerCase())?.amount;
      if (min === undefined) throw new Named("RELAYER_FEE_ASSET", describe("RELAYER_FEE_ASSET", ""), false);
      return { value: fee, to: { auth: addr.auth, pk: addr.pk } };
    };
    const reserve = (notes: readonly HeldNote[]) => {
      op.data.reserves = [...(op.data.reserves ?? []), ...notes.map((n) => toHex32(n.nullifier))];
    };
    switch (i.t) {
      case "unshield":
      case "transfer": {
        const fee = i.t === "unshield" && i.direct ? 0n : i.fee;
        const notes = this.selectOrThrow(id, i.asset, i.amount + fee);
        reserve(notes);
        const total = notes.reduce((s, n) => s + n.value, 0n);
        const change = total - i.amount - fee;
        const self = addressOf(notes[0]!.keys);
        const feeNote = i.t === "unshield" && i.direct ? null : relayerFeeNote(i.asset, fee);
        const outs: { value: bigint; to: PrivateAddress }[] = i.t === "transfer" ? [{ value: i.amount, to: recipientOf(i.to) }, { value: change, to: self }] : [{ value: change, to: self }];
        if (feeNote) {
          while (outs.length < 2) outs.push({ value: 0n, to: self });
          outs.push(feeNote);
        }
        const w = this.spendParts(notes, i.asset, outs, i.t === "unshield" ? { amount: i.amount, recipient: BigInt(i.recipient) } : undefined);
        parts.push(await this.proveTo(id, "spend", "spend", w.inputs, w.publicInputs, 0));
        break;
      }
      case "combine": {
        const notes = largestPair(this.decoded!.notes.filter((n) => n.asset === BigInt(i.asset) && n.leafIndex < this.chain.processed));
        if (notes.length < 2) throw new Named("NOTHING_TO_COMBINE", "There's nothing to combine: this asset is already in one note per address.", false);
        reserve(notes);
        const w = this.spendParts(notes, i.asset, [{ value: notes.reduce((s, n) => s + n.value, 0n), to: addressOf(main) }]);
        parts.push(await this.proveTo(id, "spend", "spend", w.inputs, w.publicInputs, 0));
        break;
      }
      case "perpOpen":
      case "makerLock": {
        const m = this.market(i.market);
        const amount = i.t === "perpOpen" ? i.margin : i.amount;
        const notes = this.selectOrThrow(id, m.collateral, amount);
        reserve(notes);
        op.data.payoutIndex ??= this.nextPayout(id);
        const expiry = this.lockExpiry(op, i.expiry);
        const terms = i.t === "perpOpen" ? takerTerms(i.market, i.isShort, i.size, i.limit) : makerTerms(i.market, i.spreadBps, i.maxSize, i.closeSpreadBps);
        const w = await this.buildLock(notes, m.collateral, amount, terms, expiry, op.data.payoutIndex);
        parts.push(await this.proveTo(id, "lock", "lock", w.inputs, w.publicInputs, 0));
        op.data.lockIds = [toHex32(lockCommitment(dep.id, w.record))];
        break;
      }
      case "swap": {
        const notes = this.selectOrThrow(id, i.assetIn, i.amountIn);
        reserve(notes);
        op.data.payoutIndex ??= this.nextPayout(id);
        const expiry = this.lockExpiry(op, i.expiry);
        const w = await this.buildLock(notes, i.assetIn, i.amountIn, swapTerms(i.pool, i.minOut, i.secondPool), expiry, op.data.payoutIndex);
        parts.push(await this.proveTo(id, "lock", "lock", w.inputs, w.publicInputs, 0));
        op.data.lockIds = [toHex32(lockCommitment(dep.id, w.record))];
        break;
      }
      case "lpAdd": {
        const pool = this.chain.pools.find((p) => p.id === i.pool);
        if (!pool) throw new Named("UNKNOWN_POOL", "This pool isn't in the current deployment.", false);
        const [n0, n1] = [this.selectOrThrow(id, pool.token0, i.amount0), this.selectOrThrow(id, pool.token1, i.amount1)];
        reserve(n0);
        reserve(n1);
        op.data.payoutIndex ??= this.nextPayout(id);
        op.data.link ??= randomField();
        const expiry = this.lockExpiry(op, i.expiry);
        const a = await this.buildLock(n0, pool.token0, i.amount0, lpTerms(i.pool, 0n, i.minShares, op.data.link), expiry, op.data.payoutIndex);
        const b = await this.buildLock(n1, pool.token1, i.amount1, lpTerms(i.pool, 1n, i.minShares, op.data.link), expiry, op.data.payoutIndex);
        parts.push(await this.proveTo(id, "lock", "lock", a.inputs, a.publicInputs, 0));
        parts.push(await this.proveTo(id, "lock", "lock", b.inputs, b.publicInputs, 1));
        op.data.lockIds = [toHex32(lockCommitment(dep.id, a.record)), toHex32(lockCommitment(dep.id, b.record))];
        break;
      }
      case "release": {
        const held = this.decoded!.locks.find((l) => toHex32(l.commitment) === i.lock);
        if (!held) throw new Named("UNKNOWN_LOCK", "This lock wasn't found in your account.", false);
        this.requireInTree(held.leafIndex);
        if (held.record.expiry >= now) throw new Named("LOCK_NOT_EXPIRED", "A lock can only come back after its expiry.", false);
        const w = releaseWitness({ held: { record: held.record, leafIndex: held.leafIndex }, deployment: dep.id, tree, asOf: now });
        parts.push(await this.proveTo(id, "release", "release", w.inputs, w.publicInputs, 0));
        break;
      }
      case "update": {
        const pos = this.position(i.position);
        const last = pos.versions.at(-1)!;
        const m = this.market(last.pair.market);
        const actor = pos.side === "taker" ? ACTOR_TAKER : ACTOR_MAKER;
        if ((i.remove > 0n || i.reduce > 0n) && m.mark === null) throw new Named("ORACLE_STALE", describe("ORACLE_STALE", ""), true);
        const note = i.add > 0n ? this.selectOrThrow(id, m.collateral, i.add).find((n) => n.value >= i.add) : undefined;
        if (i.add > 0n && !note) throw new Named("FRAGMENTED", "Adding margin needs one note large enough. Combine notes in Funds, then try again.", false);
        if (note) reserve([note]);
        const { riskKeys } = await this.chain.readOperatorKeys();
        const w = updateWitness({
          pair: last.pair, leafIndex: last.leafIndex, deployment: dep.id, tree, update: { actor, add: i.add, remove: i.remove, reduce: i.reduce }, sk: pos.keys.sk, noteOwner: note?.keys ?? main, note, mark: m.mark ?? 0n, imrWad: m.imrWad, scale: m.scale,
          feeBps: m.takerFeeBps, fundingIndex: m.fundingIndex, riskKeys, feeTo: dep.feeTo, carryExit: this.chain.exits.has(toHex32(last.nullifier)),
        });
        if (w.outcome.refused) throw new Named("POSITION_REFUSED", refusalCopy(w.outcome.refused), false);
        parts.push(await this.proveTo(id, "updatePair", "pair_update", w.inputs, w.publicInputs, 0));
        break;
      }
      case "close": {
        const pos = this.position(i.position);
        const last = pos.versions.at(-1)!;
        const m = this.market(last.pair.market);
        if (m.mark === null) throw new Named("ORACLE_STALE", describe("ORACLE_STALE", ""), true);
        const w = closeWitness({ pair: last.pair, leafIndex: last.leafIndex, deployment: dep.id, tree, mode: CLOSE_TAKER, mark: m.mark, scale: m.scale, fundingIndex: m.fundingIndex, sk: pos.keys.sk, feeBps: m.takerFeeBps, feeTo: dep.feeTo });
        parts.push(await this.proveTo(id, "closePair", "close_pair", w.inputs, w.publicInputs, 0));
        break;
      }
      case "exit": {
        const pos = this.position(i.position);
        const last = pos.versions.at(-1)!;
        const w = exitRequestWitness({ pair: last.pair, leafIndex: last.leafIndex, deployment: dep.id, tree, sk: pos.keys.sk });
        parts.push(await this.proveTo(id, "requestExit", "exit_request", w.inputs, { root: w.root, nullifier: w.nullifier }, 0));
        break;
      }
      case "redeem": {
        const held = this.decoded!.claims.find((c) => toHex32(c.commitment) === i.claim);
        if (!held) throw new Named("UNKNOWN_CLAIM", "This claim wasn't found in your account.", false);
        this.requireInTree(held.leafIndex);
        const ratio = await this.chain.foldedRatio(toHex32(held.record.deltaCm));
        if (ratio === null) throw new Named("CLAIM_NOT_FOLDED", "This claim's funding epoch hasn't run yet.", true);
        const w = redeemWitness({ claim: held.record, leafIndex: held.leafIndex, deployment: dep.id, tree, ratio });
        parts.push(await this.proveTo(id, "redeemClaim", "redeem_claim", w.inputs, w.publicInputs, 0));
        break;
      }
      case "lpRequest":
      case "lpRecover": {
        const held = this.decoded!.lps.find((l) => toHex32(l.commitment) === i.claim);
        if (!held) throw new Named("UNKNOWN_LP", "This position wasn't found in your account.", false);
        this.requireInTree(held.leafIndex);
        const operator = await this.chain.readOperatorKeys();
        const keys = [operator.coordinator, operator.riskKeys[0], operator.riskKeys[1]] as const;
        const opening = i.t === "lpRequest";
        const w = lpSetWitness({ claim: held.record, leafIndex: held.leafIndex, deployment: dep.id, tree, mode: opening ? 0n : 1n, sk: opening ? held.keys.sk : 0n, min0: opening ? i.min0 : 0n, min1: opening ? i.min1 : 0n, expiry: opening ? now + i.expiry : 0n, asOf: now, keys });
        parts.push(await this.proveTo(id, "setLiquidityRequest", "lp_set", w.inputs, w.publicInputs, 0));
        break;
      }
    }
    this.update(id, { parts, data: op.data });
    this.step(id, 0, "confirmed");
  }
}

function recipientOf(address: string): PrivateAddress {
  try {
    return decodeAddress(address);
  } catch (error) {
    throw new Named("INVALID_ADDRESS", error instanceof Error ? error.message : "That isn't a Rooq private address.", false);
  }
}

function refusalCopy(refused: string): string {
  if (refused === "underwater pair cannot reduce") return "This position can't reduce while it is underwater. Add margin or wait for liquidation.";
  if (refused === "removal above margin") return "That's more margin than this position holds.";
  if (refused === "below initial margin") return "Removing that much would leave this position below its initial margin.";
  return refused;
}

function bytesToHex(b: Uint8Array): Hex {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s as Hex;
}

