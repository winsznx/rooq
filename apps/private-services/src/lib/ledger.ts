import { KIND_DEPOSIT, KIND_LEAF, leafOf, MerkleTree, RECORD_FREE, toHex32, type QueueEntry } from "@rooq/private-sdk";
import { parseEventLogs, type Address, type Hex, type Log } from "viem";
import type { ChainContext } from "./chain";
import type { Logger } from "./log";

export interface LedgerRecord {
  readonly leafIndex: number;
  readonly kind: number;
  readonly commitment: bigint;
  readonly ciphertext: readonly bigint[];
  readonly block: bigint;
  readonly tx: Hex;
}

export interface LedgerDeposit {
  readonly leafIndex: number;
  readonly asset: bigint;
  readonly amount: bigint;
  readonly inner: bigint;
  readonly block: bigint;
}

export interface FundingEvent {
  readonly market: bigint;
  readonly index: bigint;
  readonly asOf: bigint;
  readonly dt: bigint;
  readonly mark: bigint;
  readonly head: bigint;
  readonly consumed: bigint;
  readonly ciphertext: readonly bigint[];
  readonly block: bigint;
}

export interface ExitEvent {
  readonly nullifier: Hex;
  readonly requester: Address;
  readonly matureAt: bigint;
  readonly block: bigint;
}

export interface PairEndEvent {
  readonly nullifier: Hex;
  readonly kind: "closed" | "liquidated";
  readonly market: bigint;
  readonly mark: bigint;
  readonly mode: bigint | null;
  readonly block: bigint;
  readonly tx: Hex;
}

export interface UnshieldEvent {
  readonly asset: Address;
  readonly recipient: Address;
  readonly amount: bigint;
  readonly block: bigint;
  readonly tx: Hex;
}

export interface SpentNullifier {
  readonly nullifier: Hex;
  readonly block: bigint;
  readonly tx: Hex;
}

export interface Consumption {
  readonly block: bigint;
  readonly tx: Hex;
}

export interface SpotUpdate {
  readonly pool: bigint;
  readonly head: bigint;
  readonly ciphertext: readonly bigint[];
  readonly block: bigint;
}

interface Checkpoint {
  readonly n: bigint;
  readonly hash: Hex;
}

interface RootEvent {
  readonly root: bigint;
  readonly seq: bigint;
  readonly first: number;
  readonly count: number;
  readonly block: bigint;
}

interface PositionedQueueEntry extends QueueEntry {
  readonly block: bigint;
}

export interface SyncReport {
  readonly head: bigint;
  /** Set when this sync discarded blocks. */
  readonly rolledBackTo: bigint | null;
}

const ZERO = 0n;

/**
 * Everything the pool has published, rebuilt from its event logs: the only state any service starts from. Rows carry
 * their block so a reorg truncates them; the tree is rebuilt when one removes processed leaves. All of it is public.
 */
export class Ledger {
  readonly queue: PositionedQueueEntry[] = [];
  readonly records: LedgerRecord[] = [];
  readonly deposits: LedgerDeposit[] = [];
  readonly funding: FundingEvent[] = [];
  readonly exits: ExitEvent[] = [];
  readonly ends: PairEndEvent[] = [];
  readonly unshields: UnshieldEvent[] = [];
  /** Spent nullifiers in chain order, so a reader can ask for everything after a block. */
  readonly spent: SpentNullifier[] = [];
  readonly spotUpdates: SpotUpdate[] = [];
  readonly createdMarkets: { readonly market: bigint; readonly block: bigint }[] = [];
  private readonly consumed = new Map<string, Consumption>();
  private readonly roots: RootEvent[] = [];
  private treeState = new MerkleTree();
  private checkpoints: Checkpoint[] = [];
  private cursor: Checkpoint | null = null;
  private headSeen = ZERO;
  private reorgCount = 0;
  private lastReorgDepth = ZERO;
  private rollbackGeneration = 0;
  private fullRebuildCount = 0;

  constructor(
    private readonly chain: ChainContext,
    private readonly log: Logger,
  ) {}

  get tree(): MerkleTree {
    return this.treeState;
  }

  get processed(): number {
    return this.treeState.size;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get root(): bigint {
    return this.treeState.root();
  }

  get rootSeq(): bigint {
    return this.roots.at(-1)?.seq ?? 1n;
  }

  get head(): bigint {
    return this.headSeen;
  }

  get syncedBlock(): bigint | null {
    return this.cursor?.n ?? null;
  }

  get reorgs(): number {
    return this.reorgCount;
  }

  get deepestReorg(): bigint {
    return this.lastReorgDepth;
  }

  /** Reorgs deeper than the retained checkpoints, each answered by a replay from the deployment block. */
  get fullRebuilds(): number {
    return this.fullRebuildCount;
  }

  /** Bumps on every rollback. A consumer that scans by position restarts when this changes. */
  get generation(): number {
    return this.rollbackGeneration;
  }

  isSpent(nullifier: bigint): boolean {
    return this.consumed.has(toHex32(nullifier));
  }

  consumption(nullifier: Hex): Consumption | undefined {
    return this.consumed.get(nullifier);
  }

  consumptionTxs(): Hex[] {
    return [...new Set([...this.consumed.values()].map((c) => c.tx))];
  }

  latestFunding(market: bigint): FundingEvent | undefined {
    for (let i = this.funding.length - 1; i >= 0; i--) {
      const e = this.funding[i]!;
      if (e.market === market) return e;
    }
    return undefined;
  }

  latestSpotUpdate(pool: bigint): SpotUpdate | undefined {
    for (let i = this.spotUpdates.length - 1; i >= 0; i--) {
      const e = this.spotUpdates[i]!;
      if (e.pool === pool) return e;
    }
    return undefined;
  }

  exitFor(nullifier: bigint): ExitEvent | undefined {
    const key = toHex32(nullifier);
    return this.exits.find((e) => e.nullifier === key);
  }

  async sync(): Promise<SyncReport> {
    const { client } = this.chain;
    const head = await client.getBlockNumber({ cacheTime: 0 });
    this.headSeen = head;
    const rolledBackTo = await this.detectReorg(head);
    let step = this.chain.config.logRangeBlocks;
    for (;;) {
      const from = this.cursor ? this.cursor.n + 1n : this.chain.startBlock;
      if (from > head) break;
      const to = from + step - 1n < head ? from + step - 1n : head;
      const toHash = await this.hashAt(to);
      if (!toHash) break;
      let logs: Log[];
      try {
        logs = await client.getLogs({ address: [this.chain.pool, ...(this.chain.spot ? [this.chain.spot] : []), ...(this.chain.marketsModule ? [this.chain.marketsModule] : [])], fromBlock: from, toBlock: to });
      } catch (error) {
        if (step > 1n && /range|limit|too many|exceed|response size/i.test(error instanceof Error ? error.message : String(error))) {
          step = step / 2n;
          continue;
        }
        throw error;
      }
      // A reorg between these reads would otherwise splice logs from two branches onto the cursor.
      const [cursorHash, toHashAfter] = await Promise.all([this.cursor ? this.hashAt(this.cursor.n) : Promise.resolve(null), this.hashAt(to)]);
      if (toHashAfter !== toHash || (this.cursor && cursorHash !== this.cursor.hash)) break;
      this.apply(logs, to, toHash);
    }
    return { head, rolledBackTo };
  }

  private async hashAt(n: bigint): Promise<Hex | null> {
    try {
      const b = await this.chain.client.getBlock({ blockNumber: n });
      return b.hash;
    } catch (error) {
      if (error instanceof Error && error.name === "BlockNotFoundError") return null;
      throw error;
    }
  }

  private async detectReorg(head: bigint): Promise<bigint | null> {
    const cursor = this.cursor;
    if (!cursor) return null;
    const hash = head >= cursor.n ? await this.hashAt(cursor.n) : null;
    if (hash === cursor.hash) return null;
    const ancestor = await this.findAncestor();
    const target = ancestor?.n ?? null;
    this.rollback(target);
    this.reorgCount += 1;
    if (target === null) this.fullRebuildCount += 1;
    this.lastReorgDepth = cursor.n - (target ?? this.chain.startBlock - 1n);
    this.log.warn("reorg_rolled_back", { from: cursor.n, to: target, depth: this.lastReorgDepth, processed: this.processed, queue: this.queueLength });
    return target ?? this.chain.startBlock - 1n;
  }

  /** Whether a checkpoint is still canonical is monotone in height, so the fork point is found by bisection. */
  private async findAncestor(): Promise<Checkpoint | null> {
    let lo = 0;
    let hi = this.checkpoints.length - 1;
    let best: Checkpoint | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cp = this.checkpoints[mid]!;
      if ((await this.hashAt(cp.n)) === cp.hash) {
        best = cp;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  /** Discards everything above `ancestor`. Null means no retained checkpoint survived: a full rebuild from deployment. */
  private rollback(ancestor: bigint | null): void {
    const limit = ancestor ?? -1n;
    const popAbove = <T extends { block: bigint }>(rows: T[]): void => {
      while (rows.length > 0 && rows[rows.length - 1]!.block > limit) rows.pop();
    };
    popAbove(this.queue);
    popAbove(this.records);
    popAbove(this.deposits);
    popAbove(this.funding);
    popAbove(this.exits);
    popAbove(this.ends);
    popAbove(this.unshields);
    popAbove(this.spent);
    popAbove(this.spotUpdates);
    popAbove(this.createdMarkets);
    popAbove(this.roots);
    for (const [nf, c] of this.consumed) if (c.block > limit) this.consumed.delete(nf);
    this.checkpoints = this.checkpoints.filter((cp) => cp.n <= limit);
    this.cursor = this.checkpoints.at(-1) ?? null;
    this.rebuildTree();
    this.rollbackGeneration += 1;
  }

  private rebuildTree(): void {
    const processed = this.roots.reduce((sum, r) => sum + r.count, 0);
    const tree = new MerkleTree();
    for (let i = 0; i < processed; i++) tree.insert(this.leaf(i));
    this.treeState = tree;
  }

  private leaf(index: number): bigint {
    const entry = this.queue[index];
    if (!entry) throw new Error(`queue entry ${index} missing`);
    return leafOf(entry, this.chain.deploymentId);
  }

  /** Synchronous: readers on other tasks only ever see a whole range applied. */
  private apply(logs: readonly Log[], to: bigint, toHash: Hex): void {
    const parsed = parseEventLogs({ abi: this.chain.abi, logs: [...logs], strict: false });
    for (const log of parsed) {
      const block = log.blockNumber;
      const tx = log.transactionHash;
      if (block === null || tx === null || log.blockHash === null) continue;
      this.addCheckpoint(block, log.blockHash);
      const args = log.args as unknown as Record<string, unknown>;
      switch (log.eventName) {
        case "Shielded": {
          const leafIndex = Number(args.leafIndex as bigint);
          const asset = BigInt(args.asset as Address);
          const amount = args.amount as bigint;
          const inner = BigInt(args.inner as Hex);
          this.pushQueue(leafIndex, { kind: KIND_DEPOSIT, a: inner, b: asset, c: amount, block });
          this.deposits.push({ leafIndex, asset, amount, inner, block });
          break;
        }
        case "RecordCreated": {
          const leafIndex = Number(args.leafIndex as bigint);
          const commitment = BigInt(args.commitment as Hex);
          this.pushQueue(leafIndex, { kind: KIND_LEAF, a: commitment, b: 0n, c: 0n, block });
          this.records.push({ leafIndex, kind: Number(args.kind as number), commitment, ciphertext: (args.ciphertext as readonly Hex[]).map(BigInt), block, tx });
          break;
        }
        case "NotesCreated": {
          const first = Number(args.firstLeafIndex as bigint);
          const commitments = args.commitments as readonly Hex[];
          const ciphertexts = args.ciphertexts as readonly (readonly Hex[])[];
          commitments.forEach((c, i) => {
            const commitment = BigInt(c);
            this.pushQueue(first + i, { kind: KIND_LEAF, a: commitment, b: 0n, c: 0n, block });
            this.records.push({ leafIndex: first + i, kind: RECORD_FREE, commitment, ciphertext: ciphertexts[i]!.map(BigInt), block, tx });
          });
          break;
        }
        case "RecordsConsumed":
        case "NullifiersSpent":
          for (const nf of args.nullifiers as readonly Hex[]) {
            this.consumed.set(nf, { block, tx });
            this.spent.push({ nullifier: nf, block, tx });
          }
          break;
        case "RootUpdated": {
          const event: RootEvent = { root: BigInt(args.root as Hex), seq: args.seq as bigint, first: Number(args.firstLeafIndex as bigint), count: Number(args.count as bigint), block };
          for (let i = 0; i < event.count; i++) this.treeState.insert(this.leaf(event.first + i));
          if (this.treeState.root() !== event.root) throw new Error(`rebuilt root does not match RootUpdated at block ${block}`);
          this.roots.push(event);
          break;
        }
        case "FundingAdvanced":
          this.funding.push({
            market: args.market as bigint, index: args.index as bigint, asOf: args.asOf as bigint, dt: args.dt as bigint, mark: args.mark as bigint,
            head: BigInt(args.head as Hex), consumed: args.consumed as bigint, ciphertext: (args.ciphertext as readonly Hex[]).map(BigInt), block,
          });
          break;
        case "MarketCreated":
          this.createdMarkets.push({ market: args.market as bigint, block });
          break;
        case "PoolUpdated":
          this.spotUpdates.push({ pool: args.pool as bigint, head: BigInt(args.head as Hex), ciphertext: (args.ciphertext as readonly Hex[]).map(BigInt), block });
          break;
        case "PairClosed":
          this.ends.push({ nullifier: args.nullifier as Hex, kind: "closed", market: args.market as bigint, mark: args.mark as bigint, mode: args.mode as bigint, block, tx });
          break;
        case "PairLiquidated":
          this.ends.push({ nullifier: args.nullifier as Hex, kind: "liquidated", market: args.market as bigint, mark: args.mark as bigint, mode: null, block, tx });
          break;
        case "Unshielded":
          this.unshields.push({ asset: args.asset as Address, recipient: args.recipient as Address, amount: args.amount as bigint, block, tx });
          break;
        case "ExitRequested":
          this.exits.push({ nullifier: args.nullifier as Hex, requester: args.requester as Address, matureAt: args.matureAt as bigint, block });
          break;
        default:
          break;
      }
    }
    this.addCheckpoint(to, toHash);
    this.cursor = { n: to, hash: toHash };
  }

  private pushQueue(leafIndex: number, entry: PositionedQueueEntry): void {
    if (leafIndex !== this.queue.length) throw new Error(`queue gap: leaf ${leafIndex}, have ${this.queue.length}`);
    this.queue.push(entry);
  }

  private addCheckpoint(n: bigint, hash: Hex): void {
    const last = this.checkpoints.at(-1);
    if (last && last.n === n) return;
    this.checkpoints.push({ n, hash });
    if (this.checkpoints.length > this.chain.config.checkpoints) this.checkpoints.splice(0, this.checkpoints.length - this.chain.config.checkpoints);
  }
}
