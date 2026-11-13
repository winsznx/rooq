import { keccak256 } from "viem";
import { ChainState, ServiceDown } from "./chain-state";
import type { Engine } from "./engine";
import { Named } from "./named";
import { buildPublicView } from "./public-view";
import { forgetRemembered, isVerified, loadEncrypted, loadRemembered, markVerified, openRemembered, operationsKey, rememberWithDeviceKey, rememberWithPasskey, saveEncrypted } from "./vault";
import type { AccountSource, PrivateOp, RememberedInfo, VaultStatus, WorkerEvent, WorkerRequest } from "./types";

const ctx = self as unknown as { postMessage: (m: unknown) => void; onmessage: ((e: MessageEvent) => void) | null };
const emit = (event: WorkerEvent) => ctx.postMessage(event);

interface Session {
  readonly address: string;
  readonly seed: bigint;
  readonly accountId: string;
  readonly source: AccountSource;
}

let chain: ChainState | null = null;
let session: Session | null = null;
let engine: Engine | null = null;
let currentWallet: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let persistQueue: Promise<unknown> = Promise.resolve();
type Runtime = typeof import("./account-runtime");
let runtime: Promise<Runtime> | null = null;

/** The proving engine, loaded once: on account open, or in the background after the first public view is shown. */
const loadRuntime = (): Promise<Runtime> =>
  (runtime ??= import("./account-runtime").then(async (r) => {
    r.installCrsMirror();
    await r.initCrypto();
    return r;
  }));

function emitStatus(status: VaultStatus, remembered: RememberedInfo | null, verified: boolean) {
  emit({ e: "status", status, remembered, source: session?.source ?? null, verified });
}

async function publishStatus() {
  if (session && engine) {
    const r = await loadRemembered(session.address);
    emitStatus("unlocked", r ? { method: r.method, credentialId: r.credentialId } : null, true);
    return;
  }
  if (!currentWallet) {
    emitStatus("no_wallet", null, false);
    return;
  }
  const [remembered, verified] = await Promise.all([loadRemembered(currentWallet), isVerified(currentWallet)]);
  emitStatus(remembered ? "unlock" : "sign", remembered ? { method: remembered.method, credentialId: remembered.credentialId } : null, verified);
}

function schedule() {
  if (!engine) return;
  const delay = engine.hasActive() ? 1_000 : 3_000;
  timer = setTimeout(() => {
    if (!engine) return;
    void engine.syncOnce().finally(schedule);
  }, delay);
}

let releaseSession: (() => void) | null = null;

/** One unlocked tab per account: two engines would race on the same notes and overwrite each other's records. */
function claimSession(accountId: string): Promise<boolean> {
  return new Promise((resolve) => {
    void navigator.locks.request(`rooq-private-session:${accountId}`, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(false);
        return undefined;
      }
      resolve(true);
      return new Promise<void>((release) => {
        releaseSession = release;
      });
    });
  });
}

async function stopEngine() {
  if (timer) clearTimeout(timer);
  timer = null;
  engine?.stop();
  engine = null;
  session = null;
  releaseSession?.();
  releaseSession = null;
  if (runtime) await (await runtime).destroyProvers();
}

async function openAccount(address: string, seed: bigint, source: AccountSource) {
  const r = await loadRuntime();
  chain ??= new ChainState();
  await stopEngine();
  const scanner = new r.Scanner(seed);
  const accountId = keccak256(r.toHex32(scanner.main.owner));
  if (!(await claimSession(accountId))) throw new Named("OPEN_IN_OTHER_TAB", "This account is already open in another tab. Lock it there or close that tab.", false);
  session = { address, seed, accountId, source };
  const key = await operationsKey(seed);
  const name = `ops:${accountId}`;
  const persist = (ops: readonly unknown[]) => {
    const snapshot = JSON.parse(JSON.stringify(ops, (_k, v: unknown) => (typeof v === "bigint" ? `n:${v.toString()}` : v))) as unknown;
    persistQueue = persistQueue.then(() => saveEncrypted(key, name, snapshot)).catch((error: unknown) => console.warn("rooq: operation records not stored", error));
  };
  engine = new r.Engine(chain, scanner, r.addressOfKeys(scanner.main), persist, (view, ops: readonly PrivateOp[]) => {
    if (view) emit({ e: "view", view });
    emit({ e: "ops", ops });
  });
  const stored = (await loadEncrypted<unknown[]>(key, name)) ?? [];
  engine.ops = JSON.parse(JSON.stringify(stored), (_k, v: unknown) => (typeof v === "string" && /^n:-?\d+$/.test(v) ? BigInt(v.slice(2)) : v)) as Engine["ops"];
  emit({ e: "ops", ops: engine.publicOps() });
  await engine.syncOnce();
  engine.resume();
  schedule();
  await publishStatus();
}

let runtimePrefetch: ReturnType<typeof setTimeout> | null = null;

async function publicTick() {
  chain ??= new ChainState();
  if (!engine) {
    try {
      await chain.syncPublic();
      emit({ e: "view", view: buildPublicView(chain, null) });
      // Warm the engine once the page has something to show, so opening an account doesn't wait for the download.
      runtimePrefetch ??= setTimeout(() => void loadRuntime().catch((error: unknown) => console.warn("rooq: proving engine not loaded yet", error)), 2_000);
    } catch (error) {
      console.warn("rooq: public data read failed", error);
      const code = error instanceof ServiceDown ? (error.service === "rpc" ? "NETWORK_UNREACHABLE" : `${error.service.toUpperCase()}_UNAVAILABLE`) : "SYNC_FAILED";
      if (chain.deployment) emit({ e: "view", view: buildPublicView(chain, code) });
      else emit({ e: "offline", code });
    }
  }
  setTimeout(() => void publicTick(), 4_000);
}
void publicTick();

function requireCurrentWallet(address: string) {
  if (address.toLowerCase() !== currentWallet) throw new Named("WALLET_CHANGED", "The connected wallet changed. Sign with the wallet you want to use.", false);
}

async function handle(r: WorkerRequest): Promise<unknown> {
  switch (r.m) {
    case "wallet": {
      const next = r.address?.toLowerCase() ?? null;
      if (next !== currentWallet) {
        await stopEngine();
        emit({ e: "ops", ops: [] });
        if (chain?.deployment) emit({ e: "view", view: buildPublicView(chain, null) });
      }
      currentWallet = next;
      await publishStatus();
      return true;
    }
    case "signatures": {
      requireCurrentWallet(r.address);
      if (r.first.toLowerCase() !== r.second.toLowerCase()) throw new Named("NON_DETERMINISTIC", "This wallet signed the same message two different ways, so it can't hold a stable private account. Use a passkey instead.", false);
      await markVerified(r.address);
      await openAccount(r.address, (await loadRuntime()).seedFromSignature(r.first), "signature");
      return true;
    }
    case "signature": {
      requireCurrentWallet(r.address);
      await openAccount(r.address, (await loadRuntime()).seedFromSignature(r.signature), "signature");
      return true;
    }
    case "prfSeed": {
      requireCurrentWallet(r.address);
      await openAccount(r.address, (await loadRuntime()).seedFromPrf(r.output), "passkey");
      return true;
    }
    case "unlockRemembered": {
      requireCurrentWallet(r.address);
      await openAccount(r.address, await openRemembered(r.address, r.output), "remembered");
      return true;
    }
    case "rememberPasskey": {
      if (!session) throw new Named("LOCKED", "Open your account first.", false);
      await rememberWithPasskey(session.address, session.seed, r.output, r.credentialId, session.accountId);
      await publishStatus();
      return true;
    }
    case "rememberDevice": {
      if (!session) throw new Named("LOCKED", "Open your account first.", false);
      await rememberWithDeviceKey(session.address, session.seed, session.accountId);
      await publishStatus();
      return true;
    }
    case "forgetRemembered": {
      if (session) await forgetRemembered(session.address);
      else if (currentWallet) await forgetRemembered(currentWallet);
      await publishStatus();
      return true;
    }
    case "lock": {
      await stopEngine();
      emit({ e: "ops", ops: [] });
      if (chain?.deployment) emit({ e: "view", view: buildPublicView(chain, null) });
      await publishStatus();
      return true;
    }
    case "prepareShield":
      return engine!.prepareShield();
    case "shieldFinished":
      engine!.shieldFinished(r.depositIndex, r.ok);
      return true;
    case "start":
      return engine!.start(r.op);
    case "readMark":
      return chain!.readMark(r.market);
    case "retryOp":
      engine!.retry(r.id);
      return true;
    case "cancelOp":
      engine!.cancel(r.id);
      return true;
    case "dismissOp":
      engine!.dismiss(r.id);
      return true;
    case "directOp":
      engine!.goDirect(r.id);
      return true;
    case "walletTxSent":
      engine!.walletTxSent(r.id, r.hash);
      return true;
    case "walletTxFailed":
      engine!.walletTxFailed(r.id, r.reason, r.message);
      return true;
    case "syncNow":
      void engine!.syncOnce();
      return true;
  }
}

ctx.onmessage = (event: MessageEvent<{ id: number; request: WorkerRequest }>) => {
  const { id, request } = event.data;
  handle(request).then(
    (result) => ctx.postMessage({ id, ok: true, result }),
    (error: unknown) => ctx.postMessage({ id, ok: false, reason: error instanceof Named ? error.reason : "ERROR", message: error instanceof Error ? error.message : String(error) }),
  );
};

