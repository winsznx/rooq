"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { Abi, Hash, PublicClient, TransactionReceipt } from "viem";
import { classifyError, type RooqError } from "@rooq/sdk";
import { copy, copyAt } from "@rooq/ui";
import { CHAIN, ENV } from "./env";
import { useRefreshChainData } from "./chain-data";
import { createOperation, patchOperation, releaseOperation, type OperationIcon, type OperationKind, type OperationStage, type OperationStep } from "./operations";

export type TxPhase = "idle" | "simulating" | "wallet" | "submitted" | "unconfirmed" | "confirmed" | "reverted" | "rejected" | "failed";

export interface TxStep {
  readonly label: string;
  readonly phase: TxPhase;
  readonly hash?: Hash;
  readonly blockNumber?: bigint;
  readonly blockHash?: Hash;
  readonly error?: RooqError & { message: string };
}

export interface WriteRequest {
  readonly label: string;
  readonly address: `0x${string}`;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args: readonly unknown[];
}

export interface RunOptions {
  readonly title?: string;
  readonly kind?: OperationKind;
  /** Chain-time unix seconds when a signed quote expires. */
  readonly quoteExpiresAt?: number | null;
  readonly icons?: readonly OperationIcon[];
}

const PHASE_STAGE: Record<TxPhase, OperationStep["stage"]> = {
  idle: "not_started",
  simulating: "checking",
  wallet: "awaiting_signature",
  submitted: "submitted",
  unconfirmed: "rechecking",
  confirmed: "confirmed",
  reverted: "failed",
  rejected: "rejected",
  failed: "failed",
};

/** The stage of the whole sequence: the first step that has not finished, or the last one if all did. */
function overallStage(steps: readonly TxStep[]): OperationStage {
  const running = steps.find((s) => s.phase !== "confirmed" && s.phase !== "idle");
  const stage = PHASE_STAGE[(running ?? steps[steps.length - 1]!).phase];
  return stage === "not_started" ? "checking" : stage;
}

function toOperationSteps(steps: readonly TxStep[]): OperationStep[] {
  return steps.map((s) => ({ label: s.label, stage: PHASE_STAGE[s.phase], hash: s.hash, blockNumber: s.blockNumber?.toString(), blockHash: s.blockHash, message: s.error?.message }));
}

/**
 * Base for transaction deadlines. Chain time can sit behind the wall clock on an idle chain and ahead of it
 * on a fast-forwarded one; the later of the two keeps a deadline valid against the block it lands in.
 */
export function deadlineBase(chainNow: number): number {
  return Math.max(chainNow, Math.floor(Date.now() / 1000));
}

/** "Confirmed" wording that names the chain actually used. */
export function confirmedLabel(): string {
  return ENV === "testnet" ? copy.activity.confirmed : "Confirmed on the local chain";
}

/** Settlement wording: a sequencer receipt is never presented as Ethereum finality. */
export function settlementNote(): string {
  if (ENV === "testnet") return copyAt("activity.l1Pending");
  return "Local chain. No Ethereum settlement.";
}

/**
 * Runs writes one at a time with a simulation first, so a revert is caught before the wallet opens.
 * Every confirmed receipt triggers a full chain reread; nothing is updated optimistically.
 */
export function useTxRunner(override?: PublicClient) {
  const { chainId, address } = useAccount();
  const wagmiClient = usePublicClient();
  const publicClient = override ?? wagmiClient;
  const { data: walletClient } = useWalletClient();
  const refresh = useRefreshChainData();
  const [steps, setSteps] = useState<TxStep[]>([]);
  const [busy, setBusy] = useState(false);

  // Mirrors `steps` outside React state so a run keeps reporting after its dialog or page unmounts.
  const live = useRef<{ opId: string; steps: TxStep[] } | null>(null);
  const track = useCallback((index: number, patch: Partial<TxStep>) => {
    setSteps((all) => all.map((s, i) => (i === index ? { ...s, ...patch } : s)));
    if (!live.current) return;
    const steps = live.current.steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    live.current.steps = steps;
    const stage = overallStage(steps);
    patchOperation(live.current.opId, {
      steps: toOperationSteps(steps),
      stage,
      message: steps.find((s) => s.error)?.error?.message ?? null,
      finalityNote: stage === "confirmed" ? settlementNote() : null,
    });
  }, []);

  const run = useCallback(
    async (requests: readonly WriteRequest[], options: RunOptions = {}): Promise<TransactionReceipt[] | null> => {
      setSteps(requests.map((r) => ({ label: r.label, phase: "idle" })));
      if (!publicClient || !walletClient || !address) {
        setSteps(requests.map((r) => ({ label: r.label, phase: "failed", error: { reasonCode: "INTERNAL", copyKey: "connect.error", canRetry: true, message: copyAt("connect.error") } })));
        return null;
      }
      if (chainId !== CHAIN.id) {
        setSteps(requests.map((r) => ({ label: r.label, phase: "failed", error: { reasonCode: "CHAIN_MISMATCH", copyKey: "errors.wrongNetwork", canRetry: true, message: copyAt("errors.wrongNetwork") } })));
        return null;
      }
      setBusy(true);
      const initial: TxStep[] = requests.map((r) => ({ label: r.label, phase: "idle" }));
      const opId = createOperation({
        wallet: address,
        chainId,
        kind: options.kind ?? "funds",
        title: options.title ?? requests[requests.length - 1]!.label,
        href: `${window.location.pathname}${window.location.search}`,
        steps: toOperationSteps(initial),
        quoteExpiresAt: options.quoteExpiresAt ?? null,
        icons: options.icons,
        privateChain: override !== undefined,
      });
      live.current = { opId, steps: initial };
      const receipts: TransactionReceipt[] = [];
      try {
        for (let i = 0; i < requests.length; i++) {
          const r = requests[i]!;
          track(i, { phase: "simulating" });
          let hash: Hash;
          try {
            const sim = await publicClient.simulateContract({
              address: r.address,
              abi: r.abi,
              functionName: r.functionName,
              args: r.args,
              account: address,
            });
            // Node estimates can be tight when state moves between estimate and inclusion (funding
            // settlement, oracle updates). A 25% buffer avoids out-of-gas reverts; unused gas is refunded.
            const estimate = await publicClient.estimateContractGas({
              address: r.address,
              abi: r.abi,
              functionName: r.functionName,
              args: r.args,
              account: address,
            });
            track(i, { phase: "wallet" });
            hash = await walletClient.writeContract({ ...sim.request, gas: (estimate * 125n) / 100n });
          } catch (error) {
            const e = classifyError(error);
            track(i, { phase: e.reasonCode === "USER_REJECTED" ? "rejected" : "failed", error: { ...e, message: copyAt(e.copyKey) } });
            return null;
          }
          track(i, { phase: "submitted", hash });
          let receipt: TransactionReceipt;
          try {
            receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
          } catch (error) {
            // The transaction left the wallet, so it may still land. Say that instead of "failed", and
            // stop the sequence so a later step never runs on top of an unknown outcome.
            console.warn("rooq: no receipt for", hash, error);
            track(i, { phase: "unconfirmed", hash, error: { reasonCode: "INTERNAL", copyKey: "activity.unconfirmed", canRetry: false, message: copyAt("activity.unconfirmed") } });
            refresh();
            return null;
          }
          receipts.push(receipt);
          if (receipt.status !== "success") {
            track(i, { phase: "reverted", hash, blockNumber: receipt.blockNumber, error: { reasonCode: "INTERNAL", copyKey: "activity.failed", canRetry: true, message: copyAt("activity.failed") } });
            return null;
          }
          track(i, { phase: "confirmed", hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash });
          refresh();
        }
        return receipts;
      } finally {
        releaseOperation(opId);
        live.current = null;
        setBusy(false);
      }
    },
    [address, chainId, publicClient, walletClient, refresh, track, override],
  );

  const reset = useCallback(() => setSteps([]), []);
  // Once the last transaction has left the wallet the person can walk away: the operation center follows it.
  const last = steps[steps.length - 1];
  const leavable = busy && last?.phase === "submitted";
  return { run, steps, busy, leavable, reset };
}
