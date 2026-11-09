import { encodeFunctionData, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { ChainContext } from "./chain";
import { sleep } from "./chain";
import { decodeRevert, type Reason, type RevertInfo } from "./errors";
import { errorMessage, type Logger } from "./log";

export type TxOutcome =
  | { readonly status: "confirmed"; readonly receipt: TransactionReceipt; readonly hash: Hex }
  | { readonly status: "reverted"; readonly revert: RevertInfo; readonly hash: Hex }
  | { readonly status: "refused"; readonly revert: RevertInfo }
  | { readonly status: "timeout"; readonly hash: Hex };

export interface Broadcast {
  readonly hash: Hex;
  readonly raw: Hex;
}

/**
 * One signing key. Sends are serialized and the nonce is re-read from the node each time, so a restart or a reorg that
 * rewinds the account can never leave it stuck.
 */
export class Sender {
  readonly account: PrivateKeyAccount;
  private readonly rebroadcastMs = Number(process.env.REBROADCAST_MS ?? 30_000);
  private tail: Promise<unknown> = Promise.resolve();
  private unresolved: { readonly hash: Hex; readonly raw: Hex; readonly since: number } | null = null;

  constructor(
    private readonly chain: ChainContext,
    privateKey: Hex,
    private readonly log: Logger,
    private readonly receiptTimeoutMs = Number(process.env.RECEIPT_TIMEOUT_MS ?? 60_000),
  ) {
    this.account = privateKeyToAccount(privateKey);
  }

  /** Returns the named revert if this call would fail against current chain state, or null when it would pass. */
  async simulate(functionName: string, args: readonly unknown[], value = 0n): Promise<RevertInfo | null> {
    try {
      await this.chain.client.simulateContract({ account: this.account, address: this.chain.targetFor(functionName), abi: this.chain.abi, functionName, args, value });
      return null;
    } catch (error) {
      const revert = decodeRevert(error);
      if (revert) return revert;
      throw error;
    }
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Signs and broadcasts without waiting for inclusion. Retries once when the node reports a stale nonce. */
  broadcast(functionName: string, args: readonly unknown[], value = 0n): Promise<Broadcast> {
    return this.serialize(async () => {
      const { client } = this.chain;
      const data = encodeFunctionData({ abi: this.chain.abi, functionName, args });
      const target = this.chain.targetFor(functionName);
      const estimate = await client.estimateContractGas({ account: this.account, address: target, abi: this.chain.abi, functionName, args, value, blockTag: "latest" });
      const gas = (estimate * 125n) / 100n;
      const fees = await client.estimateFeesPerGas();
      for (let attempt = 0; ; attempt++) {
        const nonce = await client.getTransactionCount({ address: this.account.address, blockTag: "pending" });
        const raw = await this.account.signTransaction({
          chainId: this.chain.chain.id, type: "eip1559", to: target, data, value, gas, nonce,
          maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        try {
          const hash = await client.sendRawTransaction({ serializedTransaction: raw });
          return { hash, raw };
        } catch (error) {
          if (attempt < 1 && /nonce/i.test(error instanceof Error ? error.message : String(error))) {
            await sleep(200);
            continue;
          }
          throw error;
        }
      }
    });
  }

  rebroadcast(raw: Hex): Promise<Hex> {
    return this.chain.client.sendRawTransaction({ serializedTransaction: raw });
  }

  /** Re-sends the signed transaction while waiting, so one dropped by a node's mempool still lands. */
  async waitForReceipt(hash: Hex, raw?: Hex, deadlineMs = this.receiptTimeoutMs): Promise<TransactionReceipt | null> {
    const deadline = Date.now() + deadlineMs;
    let nextBroadcast = Date.now() + this.rebroadcastMs;
    while (Date.now() < deadline) {
      const receipt = await this.receiptOrNull(hash);
      if (receipt) return receipt;
      if (raw && Date.now() >= nextBroadcast) {
        nextBroadcast = Date.now() + this.rebroadcastMs;
        await this.rebroadcast(raw).catch((error: unknown) => this.log.debug("rebroadcast_refused", { message: errorMessage(error) }));
      }
      await sleep(300);
    }
    return null;
  }

  async receiptOrNull(hash: Hex): Promise<TransactionReceipt | null> {
    try {
      return await this.chain.client.getTransactionReceipt({ hash });
    } catch (error) {
      if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") return null;
      throw error;
    }
  }

  /** Why a mined transaction reverted, from replaying it against the state of its block. */
  async explainRevert(receipt: TransactionReceipt, functionName: string, args: readonly unknown[], value = 0n): Promise<RevertInfo> {
    try {
      await this.chain.client.simulateContract({ account: this.account, address: this.chain.targetFor(functionName), abi: this.chain.abi, functionName, args, value, blockNumber: receipt.blockNumber });
      return { reason: "REVERTED_UNKNOWN", name: null };
    } catch (error) {
      return decodeRevert(error) ?? { reason: "REVERTED_UNKNOWN", name: null };
    }
  }

  /** The whole path for a service's own transaction: simulate, broadcast, wait, name the result. */
  async send(functionName: string, args: readonly unknown[], value = 0n): Promise<TxOutcome> {
    // Nonces are ordered, so nothing newer can land before a stuck transaction; a duplicate would only burn gas later.
    if (this.unresolved) {
      const { hash: stuck, raw: stuckRaw, since } = this.unresolved;
      if (await this.receiptOrNull(stuck)) {
        this.unresolved = null;
      } else if (Date.now() - since < this.receiptTimeoutMs * 10) {
        await this.rebroadcast(stuckRaw).catch((error: unknown) => this.log.debug("rebroadcast_refused", { message: errorMessage(error) }));
        return { status: "timeout", hash: stuck };
      } else {
        this.log.warn("tx_abandoned", { tx: stuck });
        this.unresolved = null;
      }
    }
    let hash: Hex;
    let raw: Hex;
    try {
      const refused = await this.simulate(functionName, args, value);
      if (refused) return { status: "refused", revert: refused };
      ({ hash, raw } = await this.broadcast(functionName, args, value));
    } catch (error) {
      // The node's gas estimate replays the call, so a race lost after the simulate above surfaces here. Any other
      // failure is named for a retry, so one bad send cannot abort the liquidations behind it in the same tick.
      const revert = decodeRevert(error);
      if (revert) return { status: "refused", revert };
      this.log.warn("send_failed", { functionName, message: errorMessage(error) });
      return { status: "refused", revert: { reason: "RPC_UNAVAILABLE", name: null } };
    }
    const receipt = await this.waitForReceipt(hash, raw);
    if (!receipt) {
      this.log.warn("tx_timeout", { functionName, tx: hash });
      this.unresolved = { hash, raw, since: Date.now() };
      return { status: "timeout", hash };
    }
    if (receipt.status === "success") return { status: "confirmed", receipt, hash };
    const revert = await this.explainRevert(receipt, functionName, args, value);
    return { status: "reverted", revert, hash };
  }

  balance(): Promise<bigint> {
    return this.chain.client.getBalance({ address: this.account.address });
  }
}

export const outcomeReason = (o: TxOutcome): Reason | "OK" | "TX_TIMEOUT" =>
  o.status === "confirmed" ? "OK" : o.status === "timeout" ? "TX_TIMEOUT" : o.revert.reason;
