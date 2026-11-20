import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, numberToHex, type Address, type Hex } from "viem";
import type { RawLog } from "../../src/lib/analytics-events";
import type { ChainBlock } from "../../src/lib/analytics-indexer";
import { parseWindow } from "../../src/lib/analytics-series";
import { loadTokenConfig, type TokenConfig } from "../../src/lib/analytics-token-config";
import { decodeSwap, SWAP_TOPIC, TOKEN_EVENTS, TokenIndexer, TRANSFER_TOPIC, type TokenIndexChain, type TokenIndexerOptions } from "../../src/lib/analytics-token-indexer";
import { fetchEthUsd, isBuy, poolEthOf, poolStateSlot, priceEthOf, priceSeries, swapWindow, TokenSlice, type TokenLiveChain } from "../../src/lib/analytics-token-report";
import { TokenStore } from "../../src/lib/analytics-token-store";
import { createLogger } from "../../src/lib/log";

const log = createLogger("analytics-test");
const POOL_ID: Hex = "0x921fdaeed6ddc20f4bf05401a936721f983af39c3558df7f68ea29bc40036db2";
const OTHER_POOL: Hex = `0x${"11".repeat(32)}`;
const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const TOKEN: Address = "0x56f316047b358C0D3C04540Ff47FF4373dF48ec0";
const ROUTER: Address = "0x00000000000000000000000000000000000a0be7";
const ALICE: Address = "0x364d832497792553BEE55c531344510B8Ca52657";
const BOB: Address = "0x0000000000000000000000000000000000000b0b";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const DEAD: Address = "0x000000000000000000000000000000000000dEaD";
const E18 = 10n ** 18n;
/** Real pool readings on mainnet: a buy that took the price to this sqrtPriceX96, about 4.8e-8 ETH per ROOQ. */
const SQRT_PRICE = 361027540594848802517576788453406n;

const START = 1_000n;
const T0 = 1_800_000_000 - (1_800_000_000 % 3_600);
const timeOf = (block: bigint): number => T0 + Number(block - START) * 600;

const OPTIONS: TokenIndexerOptions = { token: TOKEN, poolManager: POOL_MANAGER, poolId: POOL_ID, startBlock: START, finality: 2n, maxSpan: 8n, minSpan: 2n, budgetMs: 10_000, intervalMs: 0, concurrency: 2 };

class FakeMainnet implements TokenIndexChain {
  headBlock = 1_020n;
  logList: RawLog[] = [];
  readonly senders = new Map<Hex, Address>();
  fork = 0;
  maxLogSpan: bigint | null = null;
  private nextTx = 1;

  head(): Promise<bigint> {
    return Promise.resolve(this.headBlock);
  }

  block(number: bigint): Promise<ChainBlock> {
    return Promise.resolve({ hash: numberToHex(number + BigInt(this.fork) * 1_000_000n, { size: 32 }), time: timeOf(number) });
  }

  logs(address: Address, topics: readonly Hex[], from: bigint, to: bigint): Promise<RawLog[]> {
    if (this.maxLogSpan !== null && to - from + 1n > this.maxLogSpan) return Promise.reject(new Error("query spans too many blocks, narrow the block range"));
    return Promise.resolve(this.logList.filter((l) => l.address === address && topics.every((t, i) => l.topics[i] === t) && l.blockNumber >= from && l.blockNumber <= to && l.blockNumber <= this.headBlock));
  }

  sender(tx: Hex): Promise<Address> {
    const from = this.senders.get(tx);
    return from ? Promise.resolve(from) : Promise.reject(new Error(`tx ${tx} not found`));
  }

  swap(block: bigint, trader: Address, amount0: bigint, amount1: bigint, sqrtPriceX96 = SQRT_PRICE, poolId = POOL_ID): void {
    const tx = numberToHex(this.nextTx++, { size: 32 });
    this.senders.set(tx, trader);
    const topics = encodeEventTopics({ abi: TOKEN_EVENTS, eventName: "Swap", args: { id: poolId, sender: ROUTER } }) as Hex[];
    const data = encodeAbiParameters(
      [{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }],
      [amount0, amount1, sqrtPriceX96, 10n ** 22n, -170_000, 0],
    );
    this.logList.push({ address: POOL_MANAGER, topics, data, blockNumber: block, logIndex: 0, transactionHash: tx });
  }

  transfer(block: bigint, logIndex: number, from: Address, to: Address, value: bigint): void {
    const topics = encodeEventTopics({ abi: TOKEN_EVENTS, eventName: "Transfer", args: { from, to } }) as Hex[];
    this.logList.push({ address: TOKEN, topics, data: encodeAbiParameters([{ type: "uint256" }], [value]), blockNumber: block, logIndex, transactionHash: numberToHex(this.nextTx++, { size: 32 }) });
  }
}

function setup(): { chain: FakeMainnet; store: TokenStore; indexer: TokenIndexer } {
  const chain = new FakeMainnet();
  chain.transfer(1_000n, 0, ZERO, POOL_MANAGER, 1_000n * E18);
  chain.swap(1_003n, ALICE, -E18 / 100n, 200_000n * E18);
  chain.transfer(1_003n, 1, POOL_MANAGER, ALICE, 200n * E18);
  chain.swap(1_007n, BOB, -E18 / 50n, 400_000n * E18);
  chain.transfer(1_007n, 1, POOL_MANAGER, BOB, 400n * E18);
  chain.swap(1_012n, ALICE, E18 / 200n, -100_000n * E18, SQRT_PRICE + 10n ** 30n);
  chain.transfer(1_012n, 1, ALICE, POOL_MANAGER, 200n * E18);
  chain.transfer(1_013n, 0, BOB, DEAD, 50n * E18);
  chain.swap(1_014n, BOB, -E18, E18, SQRT_PRICE, OTHER_POOL);
  const store = new TokenStore(":memory:");
  return { chain, store, indexer: new TokenIndexer(chain, store, OPTIONS, log) };
}

describe("token math", () => {
  test("Swap and Transfer topics match the PoolManager and ERC-20 events", () => {
    expect(SWAP_TOPIC).toBe("0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f");
    expect(TRANSFER_TOPIC).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  });

  test("the pool state slot is keccak(poolId, 6)", () => {
    expect(poolStateSlot(POOL_ID)).toBe("0x7256eae013111a1acf4150cf0bff7ea37bd4641733b1529b4ac04c952576de56");
  });

  test("price is ETH per ROOQ from sqrtPriceX96, and a higher sqrt price is a cheaper ROOQ", () => {
    expect(priceEthOf(SQRT_PRICE)).toBeCloseTo(4.8159e-8, 11);
    expect(priceEthOf(SQRT_PRICE + 10n ** 30n)!).toBeLessThan(priceEthOf(SQRT_PRICE)!);
    expect(priceEthOf(0n)).toBeNull();
  });

  test("pool ETH is liquidity over sqrt price", () => {
    expect(poolEthOf({ sqrtPriceX96: 2n ** 96n, liquidity: 3n * E18 })).toBe(3);
    expect(poolEthOf({ sqrtPriceX96: 0n, liquidity: 1n })).toBeNull();
  });

  test("ETH paid in (negative amount0) is a buy", () => {
    const w = swapWindow([{ time: 0, amount0: -2n * E18, sqrtPriceX96: 1n }, { time: 0, amount0: E18 / 2n, sqrtPriceX96: 1n }]);
    expect(w).toEqual({ volumeEth: 2.5, buys: 1, sells: 1, buyEth: 2, sellEth: 0.5 });
    expect(isBuy({ time: 0, amount0: -1n, sqrtPriceX96: 1n })).toBe(true);
  });

  test("the price series carries the last price through quiet buckets from the opening price", () => {
    const w = parseWindow(new URL("http://x/?range=24h"), T0 + 3 * 3_600);
    const opening = { time: w.since - 10, amount0: -1n, sqrtPriceX96: 2n ** 96n };
    const series = priceSeries([{ time: T0 + 3_600 + 5, amount0: -1n, sqrtPriceX96: 2n * 2n ** 96n }], opening, w, undefined, 2_000);
    expect(series[0]?.v).toBe(2_000);
    expect(series.find((p) => p.t === T0)?.v).toBe(2_000);
    expect(series.find((p) => p.t === T0 + 3_600)?.v).toBe(500);
    expect(series.at(-1)?.v).toBe(500);
  });

  test("decodes the swapper's signed amounts", () => {
    const chain = new FakeMainnet();
    chain.swap(1n, ALICE, -5n, 7n);
    expect(decodeSwap(chain.logList[0]!)).toMatchObject({ amount0: -5n, amount1: 7n, sqrtPriceX96: SQRT_PRICE });
  });
});

describe("ETH/USD", () => {
  test("reads quoteUsd and names the client", async () => {
    let agent = "";
    const quote = await fetchEthUsd("https://example.test/launch", (_url, init) => {
      agent = init.headers["user-agent"] ?? "";
      return Promise.resolve(Response.json({ quoteUsd: 1796.61, priceUsd: 0.0000865 }));
    });
    expect(quote).toBe(1796.61);
    expect(agent).not.toBe("");
  });

  test("reads the CoinGecko simple-price shape", async () => {
    // #given a CoinGecko body
    const body = { ethereum: { usd: 1830.9 } };
    // #when it is fetched
    const quote = await fetchEthUsd("u", () => Promise.resolve(Response.json(body)));
    // #then the ETH price is returned
    expect(quote).toBe(1830.9);
  });

  test("refuses a missing quote and a failed response", async () => {
    await expect(fetchEthUsd("u", () => Promise.resolve(Response.json({ priceUsd: 1 })))).rejects.toThrow("ETH/USD is missing");
    await expect(fetchEthUsd("u", () => Promise.resolve(new Response("no", { status: 403 })))).rejects.toThrow("HTTP 403");
  });
});

describe("token config", () => {
  test("is off unless the RPC URL is set, and takes overrides", () => {
    expect(loadTokenConfig({}, "/data/analytics.db")).toBeNull();
    const config = loadTokenConfig({ ROOQ_TOKEN_RPC_URL: "https://rpc.example", ROOQ_TOKEN_CREATOR_RATE_BPS: "100" }, "/data/analytics.db")!;
    expect(config).toMatchObject({ token: TOKEN, poolId: POOL_ID, startBlock: 110_991_659n, creatorRateBps: 100, dbPath: "/data/token.db" });
    expect(() => loadTokenConfig({ ROOQ_TOKEN_RPC_URL: "https://rpc.example", ROOQ_TOKEN_POOL_ID: "0x12" }, "x")).toThrow("ROOQ_TOKEN_POOL_ID");
  });
});

describe("token indexer", () => {
  test("indexes this pool's swaps with their senders and keeps balances from transfers", async () => {
    const { store, indexer } = setup();
    await indexer.tick();
    expect(indexer.state()).toMatchObject({ indexedBlock: 1_018, head: 1_020, backfilling: false });
    expect(store.swapsSince(0).map((s) => s.amount0)).toEqual([-E18 / 100n, -E18 / 50n, E18 / 200n]);
    expect(store.uniqueTraders(0)).toBe(2);
    expect(store.holders([ZERO, DEAD, POOL_MANAGER])).toBe(1);
    expect(store.holders([])).toBe(3);
  });

  test("narrows refused ranges and resumes without applying a transfer twice", async () => {
    const { chain, store, indexer } = setup();
    chain.maxLogSpan = 3n;
    await indexer.tick();
    const restarted = new TokenIndexer(chain, store, OPTIONS, log);
    chain.headBlock = 1_025n;
    chain.transfer(1_022n, 0, BOB, ALICE, 350n * E18);
    await restarted.tick();
    expect(store.cursor()?.block).toBe(1_023);
    expect(store.holders([ZERO, DEAD, POOL_MANAGER])).toBe(1);
  });

  test("a changed cursor hash rebuilds from the launch block", async () => {
    const { chain, store, indexer } = setup();
    await indexer.tick();
    chain.fork = 1;
    await indexer.tick();
    expect(store.cursor()).toEqual({ block: 1_018, hash: (await chain.block(1_018n)).hash });
    expect(store.swapsSince(0).length).toBe(3);
    expect(store.holders([ZERO, DEAD, POOL_MANAGER])).toBe(1);
  });
});

describe("token report", () => {
  const config = loadTokenConfig({ ROOQ_TOKEN_RPC_URL: "https://rpc.example" }, ":memory:") as TokenConfig;
  const live: TokenLiveChain = {
    poolState: () => Promise.resolve({ sqrtPriceX96: SQRT_PRICE, liquidity: 10n ** 22n }),
    totalSupply: () => Promise.resolve(1_000_000_000n * E18),
    escrowEth: () => Promise.resolve(E18 / 4n),
    escrowRooq: () => Promise.reject(new Error("reverted")),
  };

  test("prices, window, holders and creator fees, with no trader or holder address", async () => {
    const { store, indexer } = setup();
    await indexer.tick();
    const slice = new TokenSlice(config, indexer, store, live, () => Promise.resolve(2_000), log);
    const report = await slice.report(parseWindow(new URL("http://x/?range=all&bucket=hour"), timeOf(1_020n)));
    expect(report.priceEth).toBeCloseTo(4.8159e-8, 11);
    expect(report.priceUsd!).toBeCloseTo(4.8159e-8 * 2_000, 8);
    expect(report.marketCapUsd!).toBeCloseTo(96_318, -1);
    expect(report.window).toEqual({ range: "all", volumeUsd: 70, buys: 2, sells: 1, buyUsd: 60, sellUsd: 10, uniqueTraders: 2 });
    expect(report.holders).toBe(1);
    expect(report.creatorFees).toEqual({ pendingEth: 0.25, pendingRooq: null, estimatedLifetimeUsd: 2.59, rateBps: 370 });
    expect(report.series.buys.reduce((s, p) => s + p.v, 0)).toBe(2);
    expect(report.series.volume.reduce((s, p) => s + p.v, 0)).toBe(70);
    const body = JSON.stringify(report).toLowerCase();
    for (const user of [ALICE, BOB]) expect(body).not.toContain(user.toLowerCase());
  });

  test("without an ETH/USD quote, dollar figures are null or zero and holders wait for the backfill", async () => {
    const { store, indexer } = setup();
    const slice = new TokenSlice(config, indexer, store, live, () => Promise.reject(new Error("HTTP 403")), log);
    const report = await slice.report(parseWindow(new URL("http://x/?range=7d"), timeOf(1_020n)));
    expect(report).toMatchObject({ ethUsd: null, priceUsd: null, marketCapUsd: null, holders: null });
    expect(report.creatorFees.estimatedLifetimeUsd).toBeNull();
  });
});
