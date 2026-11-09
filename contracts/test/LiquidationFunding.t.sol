// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {Types} from "../src/lib/Types.sol";
import {ClearingHouse} from "../src/perps/ClearingHouse.sol";
import {OracleAdapter} from "../src/oracle/OracleAdapter.sol";

/// T-005 funding nets to zero, T-006 insurance never negative, T-007 liquidation only when unhealthy
/// under a fresh oracle, plus the loss waterfall and bad-debt close-only response.
contract LiquidationFundingTest is Fixture {
    uint256 internal px;

    function setUp() public override {
        super.setUp();
        px = BTC_PRICE * WAD;
        _deposit(trader, 50_000e6);
        _deposit(trader2, 50_000e6);
    }

    // ---------------------------------------------------------------- funding

    function test_T005_fundingTransfersAreZeroSum() public {
        _open(trader, 0.5e18, 20_000e6, 1);
        _open(trader2, 0.1e18, 6_000e6, 2);
        uint256 ledgerBefore = vault.totalLedger();
        uint256 t1Before = ch.getPair(marketId, trader).takerMargin;
        uint256 m1Before = ch.getPair(marketId, trader).makerMargin;

        vm.warp(vm.getBlockTimestamp() + 1800);
        _setPrice(BTC_PRICE);
        ch.settleFunding(marketId, trader);

        Types.PairView memory v = ch.getPair(marketId, trader);
        assertLt(v.takerMargin, t1Before, "net-long takers pay");
        assertEq(t1Before - v.takerMargin, v.makerMargin - m1Before, "maker receives exactly what taker paid");
        assertEq(vault.totalLedger(), ledgerBefore, "funding never mints");
        _assertConservation();
    }

    function test_T005_fundingIndexIsTimingIndependent() public {
        _open(trader, 0.5e18, 20_000e6, 1);
        vm.warp(vm.getBlockTimestamp() + 600);
        _setPrice(BTC_PRICE);
        ch.accrueFunding(marketId);
        vm.warp(vm.getBlockTimestamp() + 600);
        _setPrice(BTC_PRICE);
        ch.accrueFunding(marketId);
        int256 stepped = ch.fundingIndex(marketId);

        // Fresh deployment, same position, one accrual over the same 1,200s.
        setUp();
        _open(trader, 0.5e18, 20_000e6, 1);
        vm.warp(vm.getBlockTimestamp() + 1200);
        _setPrice(BTC_PRICE);
        ch.accrueFunding(marketId);
        assertEq(ch.fundingIndex(marketId), stepped, "same rate and price => same index");
    }

    function test_fundingRateIsCappedAndSigned() public {
        _open(trader, -0.5e18, 20_000e6, 1);
        int256 rate = lens.fundingRatePerSecond(marketId);
        assertLt(rate, 0, "net-short takers: negative rate, shorts pay longs");
        int256 cap = int256(uint256(0.0001e18) / 3600);
        assertEq(rate, -cap, "fully one-sided skew hits the cap");
    }

    function test_staleOracleFreezesFundingInsteadOfFabricating() public {
        _open(trader, 0.5e18, 20_000e6, 1);
        int256 before = ch.fundingIndex(marketId);
        vm.warp(vm.getBlockTimestamp() + 7200);
        ch.accrueFunding(marketId);
        assertEq(ch.fundingIndex(marketId), before, "no movement on stale price");
    }

    function test_sameTimestampAccrualIsIdempotent() public {
        _open(trader, 0.5e18, 20_000e6, 1);
        vm.warp(vm.getBlockTimestamp() + 100);
        _setPrice(BTC_PRICE);
        ch.accrueFunding(marketId);
        int256 a = ch.fundingIndex(marketId);
        ch.accrueFunding(marketId);
        assertEq(ch.fundingIndex(marketId), a);
    }

    // ---------------------------------------------------------------- liquidation

    function test_T007_healthyAccountCannotBeLiquidated() public {
        _open(trader, 0.1e18, 3_000e6, 1);
        vm.prank(liquidator);
        vm.expectRevert(ClearingHouse.NotLiquidatable.selector);
        ch.liquidate(marketId, trader);
    }

    function test_T007_noLiquidationOnStaleOracle() public {
        _open(trader, 0.1e18, 3_000e6, 1);
        _setPrice(50_000);
        vm.warp(vm.getBlockTimestamp() + 3601);
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.PriceStale.selector, FEED_ID));
        ch.liquidate(marketId, trader);
    }

    function test_T007_thirdPartyLiquidatesUnhealthyLong() public {
        // 2x long: margin 3,000 on 6,000 notional. MM = 35% of notional at mark.
        _open(trader, 0.1e18, 3_000e6, 1);
        _setPrice(51_000); // equity 3,000 - 900 = 2,100 < MM 1,785? no: MM = 0.35 * 5,100 = 1,785
        vm.prank(liquidator);
        vm.expectRevert(ClearingHouse.NotLiquidatable.selector);
        ch.liquidate(marketId, trader);

        _setPrice(46_000); // equity 3,000 - 1,400 = 1,600 < MM 1,610
        uint256 liqFreeBefore = vault.balanceOf(vault.FREE(), liquidator);
        uint256 insBefore = backstop.insuranceOf(marketId);
        uint256 makerCommitBefore = vault.balanceOf(ch.commitDomain(marketId), maker);
        uint256 makerMargin = ch.getPair(marketId, trader).makerMargin;
        uint256 takerFreeBefore = vault.balanceOf(vault.FREE(), trader);

        vm.prank(liquidator);
        ch.liquidate(marketId, trader);

        uint256 penalty = 46e6; // 1% of 4,600 notional
        assertEq(vault.balanceOf(vault.FREE(), liquidator), liqFreeBefore + penalty / 2, "liquidator reward");
        assertEq(backstop.insuranceOf(marketId), insBefore + penalty - penalty / 2, "insurance share");
        assertEq(vault.balanceOf(ch.commitDomain(marketId), maker), makerCommitBefore + makerMargin + 1_400e6);
        assertEq(vault.balanceOf(vault.FREE(), trader), takerFreeBefore + 1_600e6 - penalty, "remainder returned");
        assertEq(ch.getPair(marketId, trader).size, 0);
        _assertConservation();
    }

    function test_liquidationGapUsesInsuranceThenBondThenRecordsBadDebt() public {
        _open(trader, 0.1e18, 3_000e6, 1);
        vm.startPrank(liquidator);
        usd.approve(address(vault), type(uint256).max);
        vault.deposit(500e6, liquidator);
        backstop.depositInsurance(marketId, 500e6);
        vm.stopPrank();

        _setPrice(20_000); // loss 4,000 vs margin 3,000 => shortfall 1,000
        uint256 makerCommitBefore = vault.balanceOf(ch.commitDomain(marketId), maker);
        uint256 makerMargin = ch.getPair(marketId, trader).makerMargin;
        vm.prank(liquidator);
        ch.liquidate(marketId, trader);

        assertEq(backstop.insuranceOf(marketId), 0, "insurance consumed first");
        assertEq(backstop.bondOf(marketId, creator), MIN_BOND - 500e6, "then creator bond");
        assertEq(
            vault.balanceOf(ch.commitDomain(marketId), maker),
            makerCommitBefore + makerMargin + 4_000e6,
            "maker made whole"
        );
        assertEq(ch.badDebt(marketId), 0);
        _assertConservation();
    }

    function test_T006_exhaustedBackstopRecordsBadDebtAndForcesCloseOnly() public {
        _open(trader, 0.1e18, 3_000e6, 1);
        _setPrice(1); // catastrophic gap: loss ~5,999.99
        vm.prank(liquidator);
        ch.liquidate(marketId, trader);
        assertEq(backstop.insuranceOf(marketId), 0);
        assertEq(backstop.bondOf(marketId, creator), 0);
        assertGt(ch.badDebt(marketId), 0, "unpaid liability stays visible");
        assertEq(uint8(registry.getMarket(marketId).perpStatus), uint8(Types.PerpStatus.CLOSE_ONLY));
        _assertConservation();
    }

    function test_unhealthyMakerSideCanBeLiquidated() public {
        _open(trader, -0.1e18, 6_000e6, 1); // maker long 0.1, maker margin = IM 3,000
        _setPrice(46_000); // maker equity 3,000 - 1,400 = 1,600 < 1,610
        uint256 takerFreeBefore = vault.balanceOf(vault.FREE(), trader);
        vm.prank(liquidator);
        ch.liquidate(marketId, trader);
        assertEq(vault.balanceOf(vault.FREE(), trader), takerFreeBefore + 6_000e6 + 1_400e6, "taker fully paid");
        _assertConservation();
    }

    function test_creatorBondLockedWhileOpenInterestExists() public {
        _open(trader, 0.1e18, 3_000e6, 1);
        vm.prank(guardian);
        registry.setPerpStatus(marketId, Types.PerpStatus.CLOSE_ONLY);
        vm.prank(creator);
        vm.expectRevert();
        backstop.withdrawBond(marketId);
    }
}
