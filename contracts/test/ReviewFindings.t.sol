// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {Types} from "../src/lib/Types.sol";
import {ClearingHouse} from "../src/perps/ClearingHouse.sol";
import {MarketPreflight} from "../src/market/MarketPreflight.sol";
import {MarketRegistry} from "../src/market/MarketRegistry.sol";
import {OracleAdapter} from "../src/oracle/OracleAdapter.sol";
import {MockPriceFeed} from "../src/oracle/MockPriceFeed.sol";

/// Regression tests for defects confirmed in the 2026-11-07 adversarial review.
contract ReviewFindingsTest is Fixture {
    uint256 internal px;

    function setUp() public override {
        super.setUp();
        px = BTC_PRICE * WAD;
        _deposit(trader, 50_000e6);
    }

    /// Critical: a stale-price partial reduce at an off-market maker price must not strip the counterparty.
    function test_stalePartialReduceAtOffMarketPriceReverts() public {
        _open(trader, 0.1e18, 3_000e6, 1);
        vm.warp(vm.getBlockTimestamp() + 3601);
        uint256 absurd = 3_060_000 * WAD;
        Types.Quote memory q = _quote(trader, -0.001e18, absurd, 2);
        bytes memory sig = _sign(q);
        vm.prank(trader);
        vm.expectRevert(ClearingHouse.StaleReduceMustClose.selector);
        ch.trade(q, sig, _params(-0.001e18, 0, 0));
    }

    /// High: a guardian close-only hold cannot be lifted by anyone through MarketPreflight.
    function test_guardianHoldBlocksPreflightReactivation() public {
        vm.prank(guardian);
        registry.setPerpStatus(marketId, Types.PerpStatus.CLOSE_ONLY);
        vm.expectRevert(MarketRegistry.GuardianHold.selector);
        preflight.activatePerps(marketId);

        vm.prank(admin);
        registry.releaseGuardianHold(marketId);
        preflight.activatePerps(marketId);
        assertEq(uint8(registry.getMarket(marketId).perpStatus), uint8(Types.PerpStatus.ACTIVE));
    }

    /// Medium: the registry admin cannot grant itself the preflight or clearing-house role.
    function test_adminCannotGrantWiredRoles() public {
        bytes32 preflightRole = registry.PREFLIGHT_ROLE();
        bytes32 chRole = registry.CLEARING_HOUSE_ROLE();
        vm.startPrank(admin);
        vm.expectRevert();
        registry.grantRole(preflightRole, admin);
        vm.expectRevert();
        registry.grantRole(chRole, admin);
        vm.stopPrank();
    }

    /// Medium: a live feed id cannot be repointed to another aggregator or asset.
    function test_registeredFeedCannotBeOverwritten() public {
        MockPriceFeed other = new MockPriceFeed(8, "TEST other", admin);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.FeedExists.selector, FEED_ID));
        oracle.registerFeed(FEED_ID, address(other), address(btc), 3600, 1e18, 1e30);
    }

    /// Medium: funding a payer cannot cover never draws on insurance or the creator bond.
    function test_fundingShortfallDoesNotDrawBackstop() public {
        _open(trader, 0.1e18, 3_000e6, 1);
        vm.prank(maker);
        ch.makerTopUp(marketId, trader, 9_000e6);
        _setPrice(130_000);
        vm.prank(trader);
        ch.removeMargin(marketId, 3_000e6);
        assertEq(ch.getPair(marketId, trader).takerMargin, 0, "taker margin emptied while healthy");

        uint256 bondBefore = backstop.bondOf(marketId, creator);
        uint256 insBefore = backstop.insuranceOf(marketId);
        vm.warp(vm.getBlockTimestamp() + 3600);
        _setPrice(130_000);
        ch.settleFunding(marketId, trader);
        assertEq(backstop.bondOf(marketId, creator), bondBefore, "bond untouched");
        assertEq(backstop.insuranceOf(marketId), insBefore, "insurance untouched");
        assertEq(ch.badDebt(marketId), 0, "funding shortfall is not bad debt");
        assertGt(ch.unpaidFunding(marketId), 0, "shortfall recorded");
        assertEq(uint8(registry.getMarket(marketId).perpStatus), uint8(Types.PerpStatus.ACTIVE));
        _assertConservation();
    }

    /// Medium: funding for a window nobody touched is capped at one hour per accrual.
    function test_fundingWindowCappedAtOneHour() public {
        _open(trader, 0.5e18, 20_000e6, 1);
        int256 rate = lens.fundingRatePerSecond(marketId);
        vm.warp(vm.getBlockTimestamp() + 10 hours);
        _setPrice(BTC_PRICE);
        ch.accrueFunding(marketId);
        assertEq(ch.fundingIndex(marketId), (rate * 3600 * int256(px)) / int256(WAD));
    }

    /// Low: a partial reduce succeeds when the fee has to come from position margin.
    function test_partialReduceWithEmptyFreeBalanceTakesFeeFromMargin() public {
        address t = makeAddr("tight");
        uint256 openFee = 3_600_000;
        _fund(t, 3_000e6 + openFee);
        _deposit(t, 3_000e6 + openFee);
        _open(t, 0.1e18, 3_000e6, 1);
        assertEq(vault.balanceOf(vault.FREE(), t), 0);

        Types.Quote memory q = _quote(t, -0.05e18, px, 2);
        bytes memory sig = _sign(q);
        vm.prank(t);
        ch.trade(q, sig, _params(-0.05e18, 0, 0));
        assertEq(ch.getPair(marketId, t).size, 0.05e18);
        assertEq(ch.getPair(marketId, t).takerMargin, 3_000e6 - 1_800_000);
        _assertConservation();
    }
}
