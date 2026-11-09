import type { Address, Hex } from "viem";
import { ZERO_ADDRESS, lower, type DecodedEvent, type LogPosition } from "./decode";
import type { DerivedState, ReducerContext } from "./state";

export const STREAM_TYPES = ["market.tick", "pool.swap", "perp.trade", "position.changed", "market.status", "indexer.sync", "tx.status"] as const;
export type StreamType = (typeof STREAM_TYPES)[number];

export interface EventFacts {
  /** Wallets this event belongs to in account activity (lowercase). Empty: not an activity row. */
  readonly actors: readonly Address[];
  readonly marketId: Hex | null;
  readonly streamType: StreamType | null;
}

function participants(decoded: DecodedEvent): readonly Address[] | null {
  const e = decoded.event;
  switch (decoded.contract) {
    case "clearingHouse":
      switch (e.eventName) {
        case "TradeExecuted":
        case "FundingSettled":
          return [e.args.taker, e.args.maker];
        case "Liquidated":
          return [e.args.taker, e.args.liquidator];
        case "SettledAtMark":
          return [e.args.taker];
        case "MarginChanged":
          return [e.args.account];
        case "BackingChanged":
          return [e.args.maker];
        case "ProtocolFeesClaimed":
          return [e.args.to];
        case "QuoteSignerSet":
          return [e.args.maker, e.args.signer];
        case "NonceCancelled":
        case "NonceFloorRaised":
          return [e.args.maker];
        default:
          return null;
      }
    case "marginVault":
      switch (e.eventName) {
        case "Deposited":
          return [e.args.payer, e.args.account];
        case "Withdrawn":
          return [e.args.account, e.args.to];
        default:
          return null;
      }
    case "marketRegistry":
      switch (e.eventName) {
        case "MarketCreated":
          return [e.args.creator];
        case "StatusChanged":
          return [e.args.by];
        case "PerpProposed":
        case "RiskTightened":
          return [];
        default:
          return null;
      }
    case "marketBackstop":
      switch (e.eventName) {
        case "InsuranceDeposited":
          return [e.args.from];
        case "BondPosted":
        case "BondWithdrawn":
          return [e.args.creator];
        default:
          return null;
      }
    case "marketPreflight":
      return e.eventName === "PerpsActivated" ? [e.args.by] : null;
    case "spotFactory":
      return e.eventName === "PoolCreated" ? [] : null;
    case "spotPool":
      switch (e.eventName) {
        case "SwapExecuted":
          return [e.args.sender, e.args.recipient];
        case "LiquidityAdded":
          return [e.args.sender, e.args.owner];
        case "LiquidityRemoved":
          return [e.args.sender, e.args.recipient];
        case "Skimmed":
          return [e.args.to];
        default:
          return null;
      }
    case "oracleAdapter":
    case "priceFeed":
      return null;
  }
}

function streamTypeOf(decoded: DecodedEvent): StreamType | null {
  const name = decoded.event.eventName;
  if (decoded.contract === "clearingHouse" && name === "TradeExecuted") return "perp.trade";
  if (decoded.contract === "clearingHouse" && name === "PositionChanged") return "position.changed";
  if (decoded.contract === "spotPool" && name === "SwapExecuted") return "pool.swap";
  if (decoded.contract === "marketRegistry" && name === "StatusChanged") return "market.status";
  if (decoded.contract === "priceFeed" && name === "AnswerUpdated") return "market.tick";
  return null;
}

function isBytes32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function marketOf(decoded: DecodedEvent, at: LogPosition, state: DerivedState, ctx: ReducerContext): Hex | null {
  const args: object = decoded.event.args ?? {};
  if ("marketId" in args && isBytes32(args.marketId)) return lower(args.marketId);
  if (decoded.contract === "spotPool") return state.poolMarkets.get(at.address) ?? null;
  if (decoded.contract === "priceFeed") return state.feedMarkets.get(at.address) ?? ctx.configFeedMarkets.get(at.address) ?? null;
  return null;
}

/**
 * The transaction sender is added only where the event itself does not name the person acting: events
 * with no participant field, router swaps (the pool sees the router as sender) and status changes
 * triggered by keepers. Adding it everywhere would put a maker's backing moves into a trader's feed.
 */
function includesSender(decoded: DecodedEvent, people: readonly Address[]): boolean {
  if (people.length === 0) return true;
  const name = decoded.event.eventName;
  return (decoded.contract === "spotPool" && name === "SwapExecuted") || (decoded.contract === "marketRegistry" && name === "StatusChanged");
}

/** Facts derived from a single log for querying: who it belongs to, which market, which stream type. */
export function eventFacts(decoded: DecodedEvent, at: LogPosition, state: DerivedState, ctx: ReducerContext): EventFacts {
  const people = participants(decoded);
  const actors = new Set<Address>();
  if (people !== null) {
    for (const p of people) actors.add(lower(p));
    if (at.txFrom && includesSender(decoded, people)) actors.add(at.txFrom);
  }
  actors.delete(ZERO_ADDRESS);
  return { actors: [...actors].sort(), marketId: marketOf(decoded, at, state, ctx), streamType: streamTypeOf(decoded) };
}
