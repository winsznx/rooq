import { describe, expect, test } from "bun:test";
import { getAmountOut, priceImpactBps } from "@rooq/sdk";
import { getDeployment, TESTNET_STOCK_TOKENS, TESTNET_WETH, KNOWN_IMPOSTORS } from "@rooq/config";
import {
  TEST_RELAY_SOURCE,
  assetView,
  change24hWad,
  effectiveStatus,
  hopFees,
  maxLeverageTenths,
  oracleView,
  perpView,
  poolPriceWad,
  routePriceImpactBps,
  tierName,
  type PerpRead,
} from "../src/views";

const WAD = 10n ** 18n;
const local = getDeployment("local");
const tsla = TESTNET_STOCK_TOKENS[0];

describe("assetView", () => {
  test("verifies a canonical testnet Stock Token by exact address and uses its logo", () => {
    // #given the canonical TSLA entry, addressed in lowercase
    if (!tsla) throw new Error("config has no stock tokens");
    // #when
    const view = assetView({ address: `0x${tsla.address.slice(2).toLowerCase()}`, symbol: "TSLA", name: "Tesla", decimals: 18 }, 46630, null);
    // #then
    expect([view.verified, view.assetClass, view.logoUrl, view.isTestFixture, view.verificationSource]).toEqual([
      true,
      "stock-token",
      tsla.logo?.url ?? null,
      false,
      tsla.verification.sourceUrl,
    ]);
  });

  test("does not verify the same address on another chain", () => {
    if (!tsla) throw new Error("config has no stock tokens");
    expect(assetView({ address: tsla.address, symbol: "TSLA", name: "Tesla", decimals: 18 }, 31337, null).verified).toBe(false);
  });

  test("labels Rooq's local mocks as unverified test fixtures without a logo", () => {
    // #given the local deployment's mock base token
    const base = local?.markets[0]?.base;
    if (!local || !base) throw new Error("local deployment missing");
    // #when
    const view = assetView({ address: base, symbol: "mTSLA", name: "Mock Tesla (Test fixture)", decimals: 18 }, 31337, local);
    // #then
    expect([view.verified, view.assetClass, view.logoUrl, view.isTestFixture]).toEqual([false, "test-fixture", null, true]);
  });

  test("never verifies WETH or a known impostor", () => {
    const impostor = KNOWN_IMPOSTORS[0];
    if (!impostor) throw new Error("config has no impostors");
    const views = [
      assetView({ address: TESTNET_WETH.address, symbol: "WETH", name: "Wrapped Ether", decimals: 18 }, 46630, null),
      assetView({ address: impostor.address, symbol: "USDG", name: "Global Dollar", decimals: 6 }, 46630, null),
    ];
    expect(views.map((v) => [v.verified, v.logoUrl])).toEqual([
      [false, null],
      [false, null],
    ]);
  });
});

describe("perp status", () => {
  test("ACTIVE with a stale or unreadable feed is effectively close-only", () => {
    expect([effectiveStatus("ACTIVE", { fresh: true }), effectiveStatus("ACTIVE", { fresh: false }), effectiveStatus("ACTIVE", null)]).toEqual([
      "ACTIVE",
      "CLOSE_ONLY",
      "CLOSE_ONLY",
    ]);
  });

  test("other statuses pass through", () => {
    expect(effectiveStatus("PAUSED", { fresh: true })).toBe("PAUSED");
  });

  test("max leverage is floor(10e18 / imr) in tenths", () => {
    expect([maxLeverageTenths(5n * 10n ** 17n), maxLeverageTenths(3_334n * 10n ** 14n), maxLeverageTenths(0n)]).toEqual([20, 29, 0]);
  });

  test("tier ids map to the names in config/risk-testnet.json", () => {
    expect([tierName(1), tierName(2), tierName(3), tierName(4), tierName(9)]).toEqual(["A", "B", "C", "S", "#9"]);
  });
});

describe("perpView", () => {
  const read: PerpRead = {
    status: 0,
    tierId: 0,
    risk: {
      imrWad: 0n,
      mmrWad: 0n,
      maxOiUsdWad: 0n,
      takerFeeBps: 0,
      makerFeeBps: 0,
      liqPenaltyBps: 0,
      maxDeviationBps: 0,
      maxFundingRatePerHourWad: 0n,
      minMakerBacking: 0n,
      minBond: 0n,
      version: 0,
    },
    longOi: 2n * WAD,
    shortOi: WAD,
    makerBacking: 0n,
    badDebt: 0n,
    fundingRatePerSecondWad: 0n,
    fundingIndex: 0n,
    lastFundingTime: 0n,
    insurance: 0n,
    creatorBond: 0n,
  };

  test("has no risk view and no OI notional without a perp and a mark", () => {
    const view = perpView(read, null);
    expect([view.status, view.risk, view.oiUsdWad, view.oracle]).toEqual(["NONE", null, null, null]);
  });

  test("prices open interest at the oracle mark", () => {
    const oracle = oracleView({ feedId: `0x${"1".repeat(64)}`, aggregator: `0x${"2".repeat(40)}`, priceWad: 100n * WAD, updatedAt: 10n, fresh: true, heartbeat: 60 }, 20n, null);
    expect(perpView({ ...read, status: 2 }, oracle).oiUsdWad).toBe((300n * WAD).toString());
  });
});

describe("oracleView", () => {
  test("reports unknown price and age as null, never zero", () => {
    const view = oracleView({ feedId: `0x${"1".repeat(64)}`, aggregator: `0x${"2".repeat(40)}`, priceWad: 0n, updatedAt: 0n, fresh: false, heartbeat: 3600 }, 1_000n, null);
    expect([view.price, view.updatedAt, view.ageSeconds, view.fresh]).toEqual([null, null, null, false]);
  });

  test("labels a deployment relay feed as a TEST relay with the deployment heartbeat", () => {
    // #given the local TSLA relay feed
    const market = local?.markets[0];
    if (!local || !market) throw new Error("local deployment missing");
    // #when read 30 s after its update
    const view = oracleView({ feedId: market.feedId, aggregator: market.feed, priceWad: 359n * WAD, updatedAt: 1_000n, fresh: true, heartbeat: 1 }, 1_030n, local);
    // #then
    expect([view.source, view.isTestFeed, view.heartbeatSeconds, view.ageSeconds]).toEqual([TEST_RELAY_SOURCE, true, Number(market.heartbeat), 30]);
  });
});

describe("pool math", () => {
  test("pool price is quote per base in 18 decimals, null when unfunded", () => {
    // #given 55 base (18 dec) against 20,000 quote (6 dec)
    expect([poolPriceWad(55n * WAD, 20_000_000_000n, 18, 6), poolPriceWad(0n, 1n, 18, 6)]).toEqual([(20_000n * WAD) / 55n, null]);
  });

  test("single-hop price impact equals the SDK helper", () => {
    const hop = { reserveIn: 20_000_000_000n, reserveOut: 55n * WAD, feeBps: 25 };
    const out = getAmountOut(1_000_000_000n, hop.reserveIn, hop.reserveOut, 25n);
    expect(routePriceImpactBps(1_000_000_000n, out, [hop])).toBe(Number(priceImpactBps(1_000_000_000n, out, hop.reserveIn, hop.reserveOut)));
  });

  test("multi-hop price impact compares against the chained marginal prices", () => {
    // #given two equal 1:1 pools and an output 1% short of the ideal
    const hops = [
      { reserveIn: 1_000n * WAD, reserveOut: 1_000n * WAD, feeBps: 0 },
      { reserveIn: 1_000n * WAD, reserveOut: 1_000n * WAD, feeBps: 0 },
    ];
    // #then
    expect(routePriceImpactBps(100n * WAD, 99n * WAD, hops)).toBe(100);
  });

  test("hop fees follow each pool's input-side rounding", () => {
    const hops = [{ reserveIn: 20_000_000_000n, reserveOut: 55n * WAD, feeBps: 25 }];
    expect(hopFees(1_000_000_000n, hops)).toEqual([2_500_000n]);
  });

  test("24h change uses the pre-window price when there is one, else the first in-window price", () => {
    expect([change24hWad(100n, 90n, 110n), change24hWad(null, 100n, 95n), change24hWad(null, null, null)]).toEqual([WAD / 10n, -(WAD / 20n), null]);
  });
});
