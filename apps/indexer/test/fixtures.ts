import type { Address, Hex } from "viem";
import type { DecodedEvent, IndexedEvent, LogPosition } from "../src/decode";
import type { ReducerContext } from "../src/state";

type EventOf<C extends DecodedEvent["contract"]> = Extract<DecodedEvent, { contract: C }>["event"];

export const CHAIN_ID = 31337;
export const VAULT: Address = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0";
export const BACKSTOP: Address = "0x0165878a594ca255338adfa4d48449f69242eb8f";
export const COLLATERAL: Address = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
export const BASE: Address = "0x68b1d87f95878fe05b998f19b66f4baba5de1aed";
export const POOL: Address = "0xd6915b9f39236667134150501dcb663237a76b3a";
export const FEED: Address = "0x3aa5ebb10dc797cac828524e59a333d0a371443c";
export const MARKET: Hex = "0x3a8c97516e1a9ba18c5573ed160678198372018473cb0ddf4143e38ec174bb69";
export const FEED_ID: Hex = "0x8f933725d233395d4c68a06121e37c1e519ca5d555db5ec1fb6bd527ace0533c";
export const CREATOR: Address = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
export const MAKER: Address = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
export const TAKER: Address = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const DEAD: Address = "0x000000000000000000000000000000000000dead";

export const ctx: ReducerContext = {
  chainId: CHAIN_ID,
  vault: VAULT,
  backstop: BACKSTOP,
  collateral: COLLATERAL,
  collateralDecimals: 6,
  configFeedMarkets: new Map([[FEED, MARKET]]),
  tokenDecimals: new Map([
    [COLLATERAL, 6],
    [BASE, 18],
  ]),
  feedDecimals: new Map([[FEED, 8]]),
};

/** Positions advance one log per call so events keep a strict chain order. */
export class Clock {
  private block = 100n;
  private log = 0;

  next(address: Address, opts: { newBlock?: boolean; txFrom?: Address } = {}): LogPosition {
    if (opts.newBlock) {
      this.block += 1n;
      this.log = 0;
    }
    const at: LogPosition = {
      chainId: CHAIN_ID,
      blockNumber: this.block,
      blockHash: `0x${this.block.toString(16).padStart(64, "0")}`,
      blockTimestamp: 1_800_000_000n + this.block * 2n,
      txHash: `0x${(this.block * 1000n + BigInt(this.log)).toString(16).padStart(64, "a")}`,
      txIndex: 0,
      logIndex: this.log,
      txFrom: opts.txFrom ?? TAKER,
      address,
    };
    this.log += 1;
    return at;
  }
}

export const registry = (at: LogPosition, event: EventOf<"marketRegistry">): IndexedEvent => ({ at, decoded: { contract: "marketRegistry", event } });
export const house = (at: LogPosition, event: EventOf<"clearingHouse">): IndexedEvent => ({ at, decoded: { contract: "clearingHouse", event } });
export const vault = (at: LogPosition, event: EventOf<"marginVault">): IndexedEvent => ({ at, decoded: { contract: "marginVault", event } });
export const factory = (at: LogPosition, event: EventOf<"spotFactory">): IndexedEvent => ({ at, decoded: { contract: "spotFactory", event } });
export const pool = (at: LogPosition, event: EventOf<"spotPool">): IndexedEvent => ({ at, decoded: { contract: "spotPool", event } });
export const feed = (at: LogPosition, event: EventOf<"priceFeed">): IndexedEvent => ({ at, decoded: { contract: "priceFeed", event } });
export const oracle = (at: LogPosition, event: EventOf<"oracleAdapter">): IndexedEvent => ({ at, decoded: { contract: "oracleAdapter", event } });

export function marketCreated(clock: Clock): IndexedEvent[] {
  return [
    factory(clock.next("0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9"), {
      eventName: "PoolCreated",
      args: { pool: POOL, token0: COLLATERAL, token1: BASE, feeTier: 25, index: 0n },
    }),
    registry(clock.next("0x5fc8d32690cc91d4c39d9d3abcbd16989f875707"), {
      eventName: "MarketCreated",
      args: { marketId: MARKET, base: BASE, quote: COLLATERAL, creator: CREATOR, pool: POOL },
    }),
  ];
}

export function json(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === "bigint") return `${v}n`;
    if (v instanceof Map) return [...v.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)));
    if (v instanceof Set) return [...v].sort();
    return v;
  });
}
