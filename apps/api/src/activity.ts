import { getAddress, type Address, type Hex } from "viem";
import { PERP_STATUS, absBig, formatFixed, formatPrice, shortAddress, type ActivityRow, type FinalityTier } from "@rooq/sdk";
import { tierName } from "./views";

export interface ActivitySource {
  readonly block_number: bigint;
  readonly block_timestamp: bigint;
  readonly tx_hash: Hex;
  readonly event_name: string;
  readonly args: unknown;
  readonly market_id: Hex | null;
  readonly canonical: boolean;
  readonly market_base: Address | null;
  readonly pool_token0: Address | null;
  readonly pool_token1: Address | null;
}

export interface TokenInfo {
  readonly symbol: string | null;
  readonly decimals: number;
}

export interface ActivityContext {
  readonly wallet: Address;
  readonly tokens: ReadonlyMap<string, TokenInfo>;
  readonly collateral: { readonly address: Address; readonly symbol: string; readonly decimals: number };
  readonly finality: FinalityTier;
}

type Args = Readonly<Record<string, unknown>>;

function asArgs(value: unknown): Args {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
}

function bigArg(a: Args, key: string): bigint | null {
  const v = a[key];
  return typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : null;
}

function addrArg(a: Args, key: string): string | null {
  const v = a[key];
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null;
}

function numArg(a: Args, key: string): number | null {
  const v = a[key];
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function token(ctx: ActivityContext, address: string | null): { symbol: string; decimals: number } | null {
  if (!address) return null;
  const t = ctx.tokens.get(address.toLowerCase());
  return t ? { symbol: t.symbol ?? shortAddress(getAddress(address)), decimals: t.decimals } : null;
}

/** Display precision, widened to every decimal for non-zero amounts that would otherwise print as zero. */
export function precisionFor(amount: bigint, decimals: number, normal: number): number {
  const p = Math.min(normal, decimals);
  if (amount === 0n) return p;
  return absBig(amount) < 10n ** BigInt(decimals - p) ? decimals : p;
}

function collateral(ctx: ActivityContext, amount: bigint | null): string {
  if (amount === null) return "an unknown amount";
  const { decimals, symbol } = ctx.collateral;
  return `${formatFixed(amount, decimals, precisionFor(amount, decimals, 2))} ${symbol}`;
}

function tokenAmount(ctx: ActivityContext, address: string | null, amount: bigint | null): string {
  const t = token(ctx, address);
  if (!t || amount === null) return "an unknown amount";
  return `${formatFixed(amount, t.decimals, precisionFor(amount, t.decimals, t.decimals >= 8 ? 4 : 2))} ${t.symbol}`;
}

function marketSymbol(ctx: ActivityContext, row: ActivitySource): string {
  return token(ctx, row.market_base)?.symbol ?? "this market";
}

function who(ctx: ActivityContext, address: string | null): string {
  if (!address) return "an unknown account";
  return address === ctx.wallet.toLowerCase() ? "you" : shortAddress(getAddress(address));
}

/** One sentence per event, from the viewing wallet's side where that is unambiguous. */
export function describe(row: ActivitySource, ctx: ActivityContext): { action: string; summary: string } {
  const a = asArgs(row.args);
  const me = ctx.wallet.toLowerCase();
  const sym = marketSymbol(ctx, row);
  switch (row.event_name) {
    case "Deposited":
      return { action: "vault.deposit", summary: `Deposited ${collateral(ctx, bigArg(a, "amount"))} into the margin vault for ${who(ctx, addrArg(a, "account"))}` };
    case "Withdrawn":
      return { action: "vault.withdraw", summary: `Withdrew ${collateral(ctx, bigArg(a, "amount"))} from the margin vault to ${who(ctx, addrArg(a, "to"))}` };
    case "TradeExecuted": {
      const size = bigArg(a, "sizeDelta") ?? 0n;
      const price = formatPrice(bigArg(a, "price"));
      const isTaker = addrArg(a, "taker") === me;
      const side = isTaker ? (size > 0n ? "Bought" : "Sold") : size > 0n ? "Sold as maker" : "Bought as maker";
      const fee = isTaker ? `, fee ${collateral(ctx, bigArg(a, "fee"))}` : "";
      return { action: "perp.trade", summary: `${side} ${formatFixed(absBig(size), 18, precisionFor(size, 18, 4))} ${sym} perp at ${price}${fee}` };
    }
    case "FundingSettled": {
      const paid = bigArg(a, "takerPaid") ?? 0n;
      const owed = bigArg(a, "takerOwed") ?? paid;
      const takerPays = owed > 0n;
      const isTaker = addrArg(a, "taker") === me;
      const paying = isTaker === takerPays;
      const verb = paying ? "Paid" : "Received";
      const shortfall = absBig(owed) - absBig(paid);
      const gap = shortfall > 0n ? ` of ${collateral(ctx, absBig(owed))} ${paying ? "owed" : "due"}, ${collateral(ctx, shortfall)} written off` : "";
      return { action: "perp.funding", summary: `${verb} ${collateral(ctx, absBig(paid))}${gap} funding on ${sym}` };
    }
    case "Liquidated": {
      const mark = formatPrice(bigArg(a, "markPrice"));
      const side = a.makerSide === true ? "maker side" : "taker side";
      if (addrArg(a, "liquidator") === me && addrArg(a, "taker") !== me) {
        return { action: "perp.liquidation", summary: `Liquidated the ${side} of ${who(ctx, addrArg(a, "taker"))} on ${sym} at ${mark}` };
      }
      return { action: "perp.liquidation", summary: `${sym} position liquidated (${side}) at ${mark}, penalty ${collateral(ctx, bigArg(a, "penalty"))}` };
    }
    case "SettledAtMark":
      return { action: "perp.settled", summary: `${sym} position settled at mark ${formatPrice(bigArg(a, "markPrice"))}` };
    case "MarginChanged": {
      const delta = bigArg(a, "delta") ?? 0n;
      return delta >= 0n
        ? { action: "perp.margin", summary: `Moved ${collateral(ctx, delta)} margin into the ${sym} position` }
        : { action: "perp.margin", summary: `Released ${collateral(ctx, -delta)} margin from the ${sym} position` };
    }
    case "BackingChanged": {
      const delta = bigArg(a, "delta") ?? 0n;
      const verb = delta >= 0n ? "Committed" : "Released";
      return { action: "maker.backing", summary: `${verb} ${collateral(ctx, absBig(delta))} maker backing on ${sym} (total ${collateral(ctx, bigArg(a, "commitTotal"))})` };
    }
    case "ProtocolFeesClaimed":
      return { action: "fees.claimed", summary: `Claimed ${collateral(ctx, bigArg(a, "amount"))} protocol fees` };
    case "QuoteSignerSet":
      return { action: "maker.signer", summary: `Set the quote signer to ${who(ctx, addrArg(a, "signer"))}` };
    case "NonceCancelled":
      return { action: "maker.nonce", summary: `Cancelled quote nonce ${bigArg(a, "nonce") ?? "?"}` };
    case "NonceFloorRaised":
      return { action: "maker.nonce", summary: `Raised the quote nonce floor to ${bigArg(a, "floor") ?? "?"}` };
    case "MarketCreated":
      return { action: "market.created", summary: `Created the ${token(ctx, addrArg(a, "base"))?.symbol ?? "new"}/${token(ctx, addrArg(a, "quote"))?.symbol ?? "quote"} market` };
    case "PerpProposed": {
      const tier = numArg(a, "tierId");
      return { action: "market.perp_proposed", summary: `Proposed perps on ${sym} (tier ${tier === null ? "?" : tierName(tier)})` };
    }
    case "StatusChanged":
      return { action: "market.status", summary: `${sym} perps moved from ${statusName(numArg(a, "from"))} to ${statusName(numArg(a, "to"))}` };
    case "RiskTightened":
      return { action: "market.risk", summary: `Tightened risk limits on ${sym}` };
    case "PerpsActivated":
      return { action: "market.activated", summary: `Activated perps on ${sym}` };
    case "InsuranceDeposited":
      return { action: "backstop.insurance", summary: `Deposited ${collateral(ctx, bigArg(a, "amount"))} insurance for ${sym}` };
    case "BondPosted":
      return { action: "backstop.bond", summary: `Posted a ${collateral(ctx, bigArg(a, "amount"))} creator bond for ${sym}` };
    case "BondWithdrawn":
      return { action: "backstop.bond", summary: `Withdrew the ${collateral(ctx, bigArg(a, "amount"))} creator bond for ${sym}` };
    case "PoolCreated":
      return { action: "pool.created", summary: `Created a ${token(ctx, addrArg(a, "token0"))?.symbol ?? "?"}/${token(ctx, addrArg(a, "token1"))?.symbol ?? "?"} pool` };
    case "SwapExecuted":
      return {
        action: "pool.swap",
        summary: `Swapped ${tokenAmount(ctx, addrArg(a, "tokenIn"), bigArg(a, "amountIn"))} for ${tokenAmount(ctx, addrArg(a, "tokenOut"), bigArg(a, "amountOut"))}`,
      };
    case "LiquidityAdded":
      return {
        action: "pool.liquidity_added",
        summary: `Added ${tokenAmount(ctx, row.pool_token0, bigArg(a, "amount0"))} and ${tokenAmount(ctx, row.pool_token1, bigArg(a, "amount1"))} of liquidity`,
      };
    case "LiquidityRemoved":
      return {
        action: "pool.liquidity_removed",
        summary: `Removed ${tokenAmount(ctx, row.pool_token0, bigArg(a, "amount0"))} and ${tokenAmount(ctx, row.pool_token1, bigArg(a, "amount1"))} of liquidity`,
      };
    case "Skimmed":
      return { action: "pool.skimmed", summary: "Skimmed tokens sent to the pool outside its reserves" };
    default:
      return { action: row.event_name, summary: row.event_name };
  }
}

function statusName(code: number | null): string {
  return code === null ? "an unknown status" : (PERP_STATUS[code] ?? `status ${code}`);
}

export function activityRow(row: ActivitySource, ctx: ActivityContext): ActivityRow {
  const { action, summary } = describe(row, ctx);
  return {
    txHash: row.tx_hash,
    blockNumber: row.block_number.toString(),
    timestamp: Number(row.block_timestamp),
    action,
    marketId: row.market_id,
    summary,
    state: row.canonical ? "mined" : "rechecking",
    finality: ctx.finality,
    canonical: row.canonical,
  };
}
