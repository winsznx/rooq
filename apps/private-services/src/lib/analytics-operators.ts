import { getAddress, isAddress, type Address } from "viem";
import { errorMessage, type Logger } from "./log";

/** One of our own EOAs, named so the admin page can show it. These are public addresses, never keys. */
export interface Operator {
  readonly label: string;
  readonly address: Address;
}

export interface OperatorState {
  readonly balanceWei: bigint;
  /** Null until the first read at an indexed block. */
  readonly nonce: number | null;
  readonly at: number;
}

export interface OperatorChain {
  balance(address: Address): Promise<bigint>;
  nonce(address: Address, block: bigint): Promise<number>;
}

const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/i;

/** `ADMIN_OPERATORS="deployer:0x…,price-relay:0x…"`. Labels and addresses must each be unique. */
export function parseOperators(raw: string | undefined): Operator[] {
  if (raw === undefined || raw.trim() === "") return [];
  const operators: Operator[] = [];
  for (const [i, entry] of raw.split(",").entries()) {
    const [label = "", address = "", ...rest] = entry.trim().split(":").map((p) => p.trim());
    if (rest.length > 0 || !LABEL.test(label)) throw new Error(`ADMIN_OPERATORS entry ${i} needs a label of letters, digits and dashes before the colon`);
    if (!isAddress(address, { strict: false })) throw new Error(`ADMIN_OPERATORS entry ${i} (${label}) is not an address`);
    const checksummed = getAddress(address);
    if (operators.some((o) => o.label === label)) throw new Error(`ADMIN_OPERATORS repeats the label ${label}`);
    if (operators.some((o) => o.address === checksummed)) throw new Error(`ADMIN_OPERATORS repeats the address for ${label}`);
    operators.push({ label, address: checksummed });
  }
  return operators;
}

/** Balances and nonces of our EOAs, refreshed on an interval. A failed read keeps the last good value. */
export class OperatorBook {
  private readonly states = new Map<Address, OperatorState>();
  private nextRefreshAt = 0;

  constructor(
    readonly operators: readonly Operator[],
    private readonly chain: OperatorChain,
    private readonly refreshMs: number,
    private readonly log: Logger,
  ) {}

  /** Lowercased, for matching against indexed senders. */
  get addresses(): string[] {
    return this.operators.map((o) => o.address.toLowerCase());
  }

  state(address: Address): OperatorState | null {
    return this.states.get(address) ?? null;
  }

  /**
   * Balances are read at the head. Nonces are read at `nonceBlock`, the indexed block, so they cover the same blocks as
   * the indexed transactions they are compared with; null skips the nonce read (the node keeps no state that far back
   * during a backfill) and keeps the last one.
   */
  async refresh(nonceBlock: bigint | null, now = Date.now()): Promise<void> {
    if (now < this.nextRefreshAt) return;
    this.nextRefreshAt = now + this.refreshMs;
    await Promise.all(this.operators.map(async (o) => {
      try {
        const previous = this.states.get(o.address)?.nonce ?? null;
        const [balanceWei, nonce] = await Promise.all([this.chain.balance(o.address), nonceBlock === null ? previous : this.chain.nonce(o.address, nonceBlock)]);
        this.states.set(o.address, { balanceWei, nonce, at: now });
      } catch (error) {
        this.log.warn("operator_read_failed", { label: o.label, message: errorMessage(error) });
      }
    }));
  }
}
