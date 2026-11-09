/**
 * Keeps maker locks posted with configured terms, funded from a shielded wallet. Locks go out through the relayer, so the
 * maker's own funding address never links its fills together on chain (D-01). All state is the wallet rebuilt from chain.
 */
import { lockAddressKeys, lockWitness, addressOf, lockCommitment, recNullifier, releaseWitness, ROLE_MAKER, makerTerms, type HeldLock } from "@rooq/private-sdk";
import { sleep } from "../lib/chain";
import { intEnv, PORTS, requireEnv, takeScalar } from "../lib/config";
import { Provers } from "../lib/provers";
import { encodeRelayBody } from "../lib/relay-codec";
import { runService, type ServiceContext } from "../lib/service";
import { ShieldedWallet, type SpendableNote } from "../lib/wallet";
import { errorMessage } from "../lib/log";

interface MakerTerms {
  readonly market: bigint;
  readonly spreadBps: bigint;
  readonly maxSize: bigint;
  readonly closeSpreadBps: bigint;
  readonly amount: bigint;
  readonly locks: number;
}

interface MakerConfig {
  readonly terms: readonly MakerTerms[];
  readonly ttlSeconds: bigint;
  /** A lock this close to expiry is not counted, so a replacement goes up before it stops being usable. */
  readonly renewBeforeSeconds: bigint;
  readonly relayerUrl: string;
}

function parseTerms(raw: string): MakerTerms[] {
  // market:spreadBps:maxSizeWad:closeSpreadBps:amount:locks, comma separated.
  const items = raw.split(",").map((t) => t.trim()).filter((t) => t !== "");
  return items.map((item) => {
    const p = item.split(":");
    if (p.length !== 6 || p.some((x) => !/^\d+$/.test(x))) throw new Error("MAKER_TERMS entries are market:spreadBps:maxSizeWad:closeSpreadBps:amount:locks");
    const [market, spread, maxSize, close, amount, locks] = p as [string, string, string, string, string, string];
    return { market: BigInt(market), spreadBps: BigInt(spread), maxSize: BigInt(maxSize), closeSpreadBps: BigInt(close), amount: BigInt(amount), locks: Number(locks) };
  });
}

class MakerService {
  private readonly wallet: ShieldedWallet;
  private nextIndexFloor = 0;
  private failures = 0;
  private retryAt = 0;

  constructor(
    private readonly ctx: ServiceContext,
    seed: bigint,
    private readonly cfg: MakerConfig,
    private readonly provers: Provers,
  ) {
    this.wallet = new ShieldedWallet(seed, ctx.chain.deploymentId);
  }

  private async relay(action: string, proof: Uint8Array, publicInputs: unknown): Promise<string> {
    const res = await fetch(`${this.cfg.relayerUrl}/v1/relay/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: encodeRelayBody(proof, publicInputs) });
    const body = (await res.json()) as { id?: string; status?: string; reasonCode?: string };
    if (!res.ok || !body.id) throw new Error(`relayer refused ${action}: ${body.reasonCode ?? res.status}`);
    for (let i = 0; i < 300; i++) {
      await sleep(250);
      const status = await fetch(`${this.cfg.relayerUrl}/v1/jobs/${body.id}`);
      const job = (await status.json()) as { status?: string; reasonCode?: string };
      if (job.status === "confirmed") return body.id;
      if (job.status === "reverted" || job.status === "reorged") throw new Error(`job ${job.status}: ${job.reasonCode ?? "unknown"}`);
    }
    throw new Error("relayer job did not settle in time");
  }

  /** One note that covers the amount, or the two smallest that do together. A lock takes at most two inputs. */
  private fundingNotes(notes: readonly SpendableNote[], amount: bigint): SpendableNote[] | null {
    const sorted = [...notes].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    const single = sorted.find((n) => n.value >= amount);
    if (single) return [single];
    const big = sorted.at(-1);
    if (!big) return null;
    const partner = sorted.find((n) => n !== big && n.keys.pk.x === big.keys.pk.x && n.value + big.value >= amount);
    return partner ? [partner, big] : null;
  }

  async tick(): Promise<void> {
    const { chain, ledger, liveness, log } = this.ctx;
    if (Date.now() < this.retryAt) return;
    const records = ledger.records;
    const now = await chain.blockTime();
    const own = this.wallet.ownLocks(records).filter((l) => l.record.role === ROLE_MAKER);
    const unspent = own.filter((l) => !ledger.isSpent(recNullifier(lockCommitment(chain.deploymentId, l.record), l.record.recNonce)));
    const usable = unspent.filter((l) => l.record.expiry > now + this.cfg.renewBeforeSeconds);
    const liveByMarket = (market: bigint): number => usable.filter((l) => l.record.market === market).length;

    // Expired locks hold idle collateral. Releasing returns them to the wallet for the next replenish.
    const expired = unspent.filter((l) => l.record.expiry <= now && l.leafIndex < ledger.processed);
    for (const l of expired) {
      const held: HeldLock = { record: l.record, leafIndex: l.leafIndex };
      const w = releaseWitness({ held, deployment: chain.deploymentId, tree: ledger.tree, asOf: now });
      try {
        await this.relay("release", (await (await this.provers.get("release")).prove(w.inputs)).proof, w.publicInputs);
        this.ctx.bump("released");
        this.ctx.recordAction("release");
      } catch (error) {
        log.warn("release_failed", { message: errorMessage(error) });
      }
      await ledger.sync();
    }

    let blocked: string | null = null;
    let target = 0;
    for (const t of this.cfg.terms) {
      target += t.locks;
      for (let have = liveByMarket(t.market); have < t.locks; have++) {
        const notes = this.wallet.notes(ledger.records, ledger.deposits, ledger.processed, (nf) => ledger.isSpent(nf));
        const inputs = this.fundingNotes(notes, t.amount);
        if (!inputs) {
          blocked = "INSUFFICIENT_SHIELDED_BALANCE";
          break;
        }
        const payoutIndex = Math.max(this.nextIndexFloor, this.wallet.usedAddresses(ledger.records).next);
        const w = lockWitness({
          keys: inputs[0]!.keys, deployment: chain.deploymentId, tree: ledger.tree, asset: BigInt(chain.asset), inputs, amount: t.amount,
          terms: makerTerms(t.market, t.spreadBps, t.maxSize, t.closeSpreadBps), expiry: now + this.cfg.ttlSeconds,
          coordinator: chain.coordinator, riskKeys: chain.riskKeys, payout: addressOf(lockAddressKeys(this.wallet.seed, payoutIndex)), view: this.wallet.main.pk,
        });
        try {
          const proof = await (await this.provers.get("lock")).prove(w.inputs);
          await this.relay("lock", proof.proof, w.publicInputs);
          this.nextIndexFloor = payoutIndex + 1;
          this.failures = 0;
          this.ctx.bump("locksPosted");
          this.ctx.recordAction("lock");
        } catch (error) {
          blocked = "RELAY_FAILED";
          this.failures += 1;
          this.retryAt = Date.now() + Math.min(60_000, 1_000 * 2 ** this.failures);
          log.warn("lock_failed", { message: errorMessage(error), retryInMs: this.retryAt - Date.now() });
          break;
        }
        await ledger.sync();
      }
    }
    liveness.blocked = blocked;
    liveness.backlog = { locksMissing: Math.max(0, target - usable.length), expiredToRelease: expired.length };
    liveness.details = { liveLocks: usable.length, targetLocks: target, ownLocksSeen: own.length };
  }
}

await runService({
  name: "maker",
  port: intEnv(process.env, "PORT", PORTS.maker, 1),
  init(ctx: ServiceContext) {
    const env = process.env;
    const cfg: MakerConfig = {
      terms: parseTerms(requireEnv(env, "MAKER_TERMS")),
      ttlSeconds: BigInt(intEnv(env, "MAKER_LOCK_TTL_S", 30 * 86_400, 60)),
      renewBeforeSeconds: BigInt(intEnv(env, "MAKER_RENEW_BEFORE_S", 3_600, 0)),
      relayerUrl: (env.MAKER_RELAYER_URL ?? `http://127.0.0.1:${PORTS.relayer}`).replace(/\/+$/, ""),
    };
    const provers = new Provers(ctx.config.proverThreads);
    const service = new MakerService(ctx, takeScalar(env, "MAKER_SEED"), cfg, provers);
    return { tick: () => service.tick(), shutdown: () => provers.destroyAll() };
  },
});
