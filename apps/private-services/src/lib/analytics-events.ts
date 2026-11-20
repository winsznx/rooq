import { decodeEventLog, parseAbi, toEventSelector, type Address, type Hex } from "viem";

/** The public events the analytics index reads, with the exact signatures the contracts emit. A unit test checks them against the build. */
export const ANALYTICS_EVENTS = parseAbi([
  "event Shielded(uint256 indexed leafIndex, address indexed asset, uint256 amount, bytes32 inner, address indexed from)",
  "event Unshielded(address indexed asset, address indexed recipient, uint256 amount, address relayer, uint256 fee)",
  "event NullifiersSpent(bytes32[2] nullifiers)",
  "event RecordCreated(uint256 indexed leafIndex, uint8 indexed kind, bytes32 commitment, bytes32[] ciphertext)",
  "event RecordsConsumed(bytes32[] nullifiers)",
  "event PairOpened(uint256 indexed market, bytes32 commitment)",
  "event PairClosed(uint256 indexed market, bytes32 nullifier, uint256 mode, uint256 mark)",
  "event PairLiquidated(uint256 indexed market, bytes32 nullifier, uint256 mark)",
  "event ExitRequested(bytes32 indexed nullifier, address indexed requester, uint256 matureAt)",
  "event FundingAdvanced(uint256 indexed market, uint256 index, uint256 asOf, uint256 dt, uint256 mark, bytes32 head, uint256 consumed, bytes32[] ciphertext)",
  "event RootUpdated(bytes32 indexed root, uint256 indexed seq, uint256 firstLeafIndex, uint256 count)",
  "event PoolUpdated(uint256 indexed pool, bytes32 head, bytes32[] ciphertext)",
  "event MarketCreated(uint256 indexed market, address indexed creator, bytes32 feedId, uint256 tier, uint256 maxOiUsdWad, uint256 bond)",
  "event BondReleased(uint256 indexed market, address indexed creator, uint256 returned, uint256 used)",
  "event MarketClosedToNewPositions(uint256 indexed market)",
  "struct Point { uint256 x; uint256 y; }",
  "struct KeySet { Point coordinator; Point riskA; Point riskB; }",
  "event KeyRotationScheduled(uint256 activatesAt, KeySet keys)",
  "event KeyRotationCancelled(uint256 activatesAt)",
  "event KeyRotationActivated(uint256 indexed epoch, KeySet keys)",
  "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)",
]);

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number]["name"];

export const POOL_EVENTS: readonly AnalyticsEventName[] = [
  "Shielded", "Unshielded", "NullifiersSpent", "RecordCreated", "RecordsConsumed", "PairOpened", "PairClosed", "PairLiquidated", "ExitRequested", "FundingAdvanced", "RootUpdated",
];
export const SPOT_EVENTS: readonly AnalyticsEventName[] = ["PoolUpdated"];
export const MARKETS_EVENTS: readonly AnalyticsEventName[] = [
  "MarketCreated", "BondReleased", "MarketClosedToNewPositions", "KeyRotationScheduled", "KeyRotationCancelled", "KeyRotationActivated",
];
export const FEED_EVENTS: readonly AnalyticsEventName[] = ["AnswerUpdated"];

export function topicOf(name: AnalyticsEventName): Hex {
  const item = ANALYTICS_EVENTS.find((e) => e.name === name);
  if (!item) throw new Error(`Unknown analytics event ${name}`);
  return toEventSelector(item);
}

export interface RawLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly transactionHash: Hex;
}

/** The fields the index keeps. Commitments, ciphertexts and nullifiers are read past and never stored. */
export type IndexedEvent =
  | { readonly name: "Shielded"; readonly asset: Address; readonly amount: bigint; readonly from: Address }
  | { readonly name: "Unshielded"; readonly asset: Address; readonly recipient: Address; readonly amount: bigint; readonly relayer: Address; readonly fee: bigint }
  | { readonly name: "RecordCreated"; readonly kind: number }
  | { readonly name: "PairOpened" | "PairClosed" | "PairLiquidated" | "FundingAdvanced"; readonly market: bigint }
  | { readonly name: "PoolUpdated"; readonly pool: bigint }
  | { readonly name: "MarketCreated"; readonly market: bigint; readonly creator: Address; readonly tier: bigint; readonly bond: bigint }
  | { readonly name: "BondReleased"; readonly market: bigint; readonly creator: Address }
  | { readonly name: "AnswerUpdated"; readonly feed: Address; readonly answer: bigint; readonly updatedAt: bigint }
  | { readonly name: NameOnlyEvent };

/** Counted by name only; operator keys in the key rotation events are public but not worth keeping. */
type NameOnlyEvent =
  | "NullifiersSpent" | "RecordsConsumed" | "ExitRequested" | "RootUpdated" | "MarketClosedToNewPositions" | "KeyRotationScheduled" | "KeyRotationCancelled" | "KeyRotationActivated";

export function decodeIndexedEvent(log: RawLog): IndexedEvent {
  const [signature, ...rest] = log.topics;
  if (!signature) throw new Error("Log has no topics");
  const decoded = decodeEventLog({ abi: ANALYTICS_EVENTS, topics: [signature, ...rest], data: log.data, strict: true });
  switch (decoded.eventName) {
    case "Shielded":
      return { name: "Shielded", asset: decoded.args.asset, amount: decoded.args.amount, from: decoded.args.from };
    case "Unshielded":
      return { name: "Unshielded", asset: decoded.args.asset, recipient: decoded.args.recipient, amount: decoded.args.amount, relayer: decoded.args.relayer, fee: decoded.args.fee };
    case "RecordCreated":
      return { name: "RecordCreated", kind: decoded.args.kind };
    case "PairOpened":
    case "PairClosed":
    case "PairLiquidated":
    case "FundingAdvanced":
      return { name: decoded.eventName, market: decoded.args.market };
    case "PoolUpdated":
      return { name: "PoolUpdated", pool: decoded.args.pool };
    case "MarketCreated":
      return { name: "MarketCreated", market: decoded.args.market, creator: decoded.args.creator, tier: decoded.args.tier, bond: decoded.args.bond };
    case "BondReleased":
      return { name: "BondReleased", market: decoded.args.market, creator: decoded.args.creator };
    case "AnswerUpdated":
      return { name: "AnswerUpdated", feed: log.address, answer: decoded.args.current, updatedAt: decoded.args.updatedAt };
    case "NullifiersSpent":
    case "RecordsConsumed":
    case "ExitRequested":
    case "RootUpdated":
    case "MarketClosedToNewPositions":
    case "KeyRotationScheduled":
    case "KeyRotationCancelled":
    case "KeyRotationActivated":
      return { name: decoded.eventName };
  }
}

/** The `event_counts` key: one count per event name, split by the public dimension that event carries. */
export function eventKind(event: IndexedEvent): string {
  switch (event.name) {
    case "RecordCreated":
      return `RecordCreated:${event.kind}`;
    case "PairOpened":
    case "PairClosed":
    case "PairLiquidated":
    case "FundingAdvanced":
      return `${event.name}:${event.market}`;
    case "PoolUpdated":
      return `PoolUpdated:${event.pool}`;
    case "AnswerUpdated":
      return answerKind(event.feed);
    default:
      return event.name;
  }
}

export const answerKind = (feed: Address): string => `AnswerUpdated:${feed.toLowerCase()}`;
