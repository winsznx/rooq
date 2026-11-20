import type { AdminIndexerState } from "@rooq/private-sdk/admin";
import { createPublicClient, decodeEventLog, defineChain, http, numberToHex, parseAbi, toEventSelector, type Address, type Hex, type PublicClient, type Transport, type Chain } from "viem";
import type { RawLog } from "./analytics-events";
import { mapLimit, RANGE_ERROR, type ChainBlock } from "./analytics-indexer";
import { TOKEN_CHAIN_ID, TOKEN_USER_AGENT, type TokenConfig } from "./analytics-token-config";
import type { SwapRow, TokenStore, TransferRow } from "./analytics-token-store";
import { errorMessage, type Logger } from "./log";

export const TOKEN_EVENTS = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
export const SWAP_TOPIC = toEventSelector(TOKEN_EVENTS[0]);
export const TRANSFER_TOPIC = toEventSelector(TOKEN_EVENTS[1]);

/** The mainnet reads the token indexer makes, so tests can drive it with a fake chain. */
export interface TokenIndexChain {
  head(): Promise<bigint>;
  block(number: bigint): Promise<ChainBlock>;
  /** `topics` filters positionally, as in eth_getLogs. */
  logs(address: Address, topics: readonly Hex[], from: bigint, to: bigint): Promise<RawLog[]>;
  sender(tx: Hex): Promise<Address>;
}

export interface TokenIndexerOptions {
  readonly token: Address;
  readonly poolManager: Address;
  readonly poolId: Hex;
  readonly startBlock: bigint;
  readonly finality: bigint;
  readonly maxSpan: bigint;
  readonly minSpan: bigint;
  readonly budgetMs: number;
  readonly intervalMs: number;
  readonly concurrency: number;
}

export function decodeSwap(log: RawLog): Omit<SwapRow, "time" | "trader"> {
  const [signature, ...rest] = log.topics;
  if (!signature) throw new Error("Log has no topics");
  const decoded = decodeEventLog({ abi: TOKEN_EVENTS, eventName: "Swap", topics: [signature, ...rest], data: log.data, strict: true });
  return { block: Number(log.blockNumber), logIndex: log.logIndex, amount0: decoded.args.amount0, amount1: decoded.args.amount1, sqrtPriceX96: decoded.args.sqrtPriceX96 };
}

export function decodeTransfer(log: RawLog): TransferRow {
  const [signature, ...rest] = log.topics;
  if (!signature) throw new Error("Log has no topics");
  const decoded = decodeEventLog({ abi: TOKEN_EVENTS, eventName: "Transfer", topics: [signature, ...rest], data: log.data, strict: true });
  return { from: decoded.args.from, to: decoded.args.to, value: decoded.args.value };
}

const byPosition = (a: RawLog, b: RawLog): number => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);

/**
 * Indexes $ROOQ pool swaps and token transfers from the launch block to the head minus a finality margin, one range per
 * commit, narrowing ranges the node refuses and backing off after failures like the testnet indexer. A cursor hash that
 * no longer matches the chain rebuilds from the launch block: balances are running totals and can't be unwound by range.
 */
export class TokenIndexer {
  private ceiling: bigint;
  private span: bigint;
  private headSeen = 0n;
  private updatedAt = 0;
  private catchingUp = true;
  private nextRunAt = 0;

  constructor(
    private readonly chain: TokenIndexChain,
    private readonly store: TokenStore,
    private readonly opts: TokenIndexerOptions,
    private readonly log: Logger,
  ) {
    this.ceiling = opts.maxSpan;
    this.span = opts.maxSpan;
  }

  private get indexedBlock(): bigint {
    const cursor = this.store.cursor();
    return cursor ? BigInt(cursor.block) : this.opts.startBlock - 1n;
  }

  /** True once the index has reached the safe head at least once, so balance counts are complete. */
  get caughtUp(): boolean {
    return !this.catchingUp;
  }

  state(): AdminIndexerState {
    const indexed = this.indexedBlock;
    return {
      indexedBlock: Number(indexed),
      head: Number(this.headSeen),
      lagBlocks: this.headSeen > indexed ? Number(this.headSeen - indexed) : 0,
      updatedAt: this.updatedAt,
      backfilling: this.catchingUp,
    };
  }

  async tick(now = Date.now()): Promise<void> {
    if (!this.catchingUp && now < this.nextRunAt) return;
    this.nextRunAt = now + this.opts.intervalMs;
    this.headSeen = await this.chain.head();
    if (!(await this.checkReorg())) return;
    const target = this.headSeen - this.opts.finality;
    const deadline = Date.now() + this.opts.budgetMs;
    while (this.indexedBlock < target && Date.now() < deadline) {
      const from = this.indexedBlock + 1n;
      const to = from + this.span - 1n < target ? from + this.span - 1n : target;
      try {
        const logs = await this.collectLogs(from, to);
        if (logs === null) {
          this.ceiling = this.span = this.span / 2n > this.opts.minSpan ? this.span / 2n : this.opts.minSpan;
          this.log.info("token_span_narrowed", { span: this.span });
          continue;
        }
        await this.indexRange(from, to, logs.swaps, logs.transfers);
      } catch (error) {
        if (this.span > this.opts.minSpan) {
          this.span = this.span / 2n > this.opts.minSpan ? this.span / 2n : this.opts.minSpan;
          this.log.info("token_span_narrowed", { span: this.span, reason: "READ_FAILED" });
        }
        throw error;
      }
      this.span = this.span * 2n < this.ceiling ? this.span * 2n : this.ceiling;
    }
    this.catchingUp = this.indexedBlock < target;
    this.updatedAt = Math.floor(Date.now() / 1000);
  }

  /** As in the testnet indexer: a lagging node skips the tick, and a mismatch must hold on a second read. */
  private async checkReorg(): Promise<boolean> {
    const cursor = this.store.cursor();
    if (!cursor) return true;
    if (BigInt(cursor.block) > this.headSeen) {
      this.log.warn("token_rpc_behind", { head: this.headSeen, indexed: cursor.block });
      return false;
    }
    for (let read = 0; read < 2; read++) {
      if ((await this.chain.block(BigInt(cursor.block))).hash.toLowerCase() === cursor.hash.toLowerCase()) return true;
    }
    this.store.reset();
    this.catchingUp = true;
    this.log.warn("token_reorg", { from: cursor.block, rebuilt: true });
    return true;
  }

  private async collectLogs(from: bigint, to: bigint): Promise<{ swaps: RawLog[]; transfers: RawLog[] } | null> {
    try {
      const [swaps, transfers] = await Promise.all([
        this.chain.logs(this.opts.poolManager, [SWAP_TOPIC, this.opts.poolId], from, to),
        this.chain.logs(this.opts.token, [TRANSFER_TOPIC], from, to),
      ]);
      return { swaps: swaps.sort(byPosition), transfers: transfers.sort(byPosition) };
    } catch (error) {
      if (this.span > this.opts.minSpan && RANGE_ERROR.test(errorMessage(error))) return null;
      throw error;
    }
  }

  private async indexRange(from: bigint, to: bigint, swapLogs: readonly RawLog[], transferLogs: readonly RawLog[]): Promise<void> {
    const decoded: { log: RawLog; swap: Omit<SwapRow, "time" | "trader"> }[] = [];
    for (const log of swapLogs) {
      try {
        decoded.push({ log, swap: decodeSwap(log) });
      } catch (error) {
        this.log.warn("token_log_skipped", { block: log.blockNumber, tx: log.transactionHash, message: errorMessage(error) });
      }
    }
    const transfers: TransferRow[] = [];
    for (const log of transferLogs) {
      try {
        transfers.push(decodeTransfer(log));
      } catch (error) {
        this.log.warn("token_log_skipped", { block: log.blockNumber, tx: log.transactionHash, message: errorMessage(error) });
      }
    }
    const blockNumbers = [...new Set(decoded.map((d) => d.log.blockNumber))];
    const txHashes = [...new Set(decoded.map((d) => d.log.transactionHash.toLowerCase() as Hex))];
    const blocks = await mapLimit(blockNumbers, this.opts.concurrency, (n) => this.chain.block(n));
    const senders = await mapLimit(txHashes, this.opts.concurrency, (h) => this.chain.sender(h));
    const timeOf = new Map(blockNumbers.map((n, i) => [n, blocks[i]!.time]));
    const senderOf = new Map(txHashes.map((h, i) => [h, senders[i]!]));
    const swaps: SwapRow[] = decoded.map(({ log, swap }) => ({
      ...swap,
      time: timeOf.get(log.blockNumber)!,
      trader: senderOf.get(log.transactionHash.toLowerCase() as Hex)!,
    }));
    const end = await this.chain.block(to);
    this.store.commit({ swaps, transfers }, { from: Number(from), to: Number(to), hash: end.hash });
    if (swaps.length + transfers.length > 0) this.log.debug("token_indexed", { from, to, swaps: swaps.length, transfers: transfers.length });
  }
}

/** A mainnet client that names itself, since the public node turns away default user agents. */
export function tokenClient(config: TokenConfig): PublicClient<Transport, Chain> {
  const chain = defineChain({
    id: TOKEN_CHAIN_ID,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  return createPublicClient({ chain, transport: http(config.rpcUrl, { fetchOptions: { headers: { "user-agent": TOKEN_USER_AGENT } }, retryCount: 2, timeout: 20_000 }) });
}

export function viemTokenIndexChain(client: PublicClient<Transport, Chain>): TokenIndexChain {
  return {
    head: () => client.getBlockNumber({ cacheTime: 0 }),
    async block(number) {
      const b = await client.getBlock({ blockNumber: number });
      return { hash: b.hash, time: Number(b.timestamp) };
    },
    async logs(address, topics, from, to) {
      const rows = await client.request({ method: "eth_getLogs", params: [{ address, topics: [...topics], fromBlock: numberToHex(from), toBlock: numberToHex(to) }] });
      const out: RawLog[] = [];
      for (const r of rows) {
        if (r.blockNumber === null || r.logIndex === null || r.transactionHash === null) continue;
        out.push({ address: r.address, topics: r.topics, data: r.data, blockNumber: BigInt(r.blockNumber), logIndex: Number(r.logIndex), transactionHash: r.transactionHash });
      }
      return out;
    },
    async sender(hash) {
      return (await client.getTransaction({ hash })).from;
    },
  };
}
