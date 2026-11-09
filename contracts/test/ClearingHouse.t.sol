// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {Types} from "../src/lib/Types.sol";
import {ClearingHouse} from "../src/perps/ClearingHouse.sol";
import {OracleAdapter} from "../src/oracle/OracleAdapter.sol";
import {MarketRegistry} from "../src/market/MarketRegistry.sol";
import {MockERC20} from "../src/tokens/MockERC20.sol";
import {MockPriceFeed} from "../src/oracle/MockPriceFeed.sol";
import {SpotPool} from "../src/spot/SpotPool.sol";

/// T-003 matched exposure sums to zero, T-004 realised PnL debits equal credits, T-008 reduce never
/// creates exposure, T-011 stale feed blocks risk increases, T-014 isolation, close-only semantics.
contract ClearingHouseTest is Fixture {
    uint256 internal px;

    function setUp() public override {
        super.setUp();
        px = BTC_PRICE * WAD;
        _deposit(trader, 50_000e6);
        _deposit(trader2, 50_000e6);
    }

    function test_T003_longCreatesExactlyOppositeMakerExposure() public {
        _open(trader, 0.2e18, 8_000e6, 1);
        Types.PairView memory v = ch.getPair(marketId, trader);
        assertEq(v.size, 0.2e18, "taker long");
        assertEq(v.maker, maker);
        assertEq(v.entryPrice, px);
        (uint256 longOi, uint256 shortOi) = ch.openInterest(marketId);
        assertEq(longOi, 0.2e18);
        assertEq(shortOi, 0);
        assertEq(v.takerMargin, 8_000e6);
        assertEq(v.makerMargin, 6_000e6, "maker posts IM = 50% of 12k notional");
        _assertConservation();
    }

    function test_T003_shortTakerMakesMakerLong() public {
        _open(trader, -0.2e18, 8_000e6, 1);
        Types.PairView memory v = ch.getPair(marketId, trader);
        assertEq(v.size, -0.2e18);
        (uint256 longOi, uint256 shortOi) = ch.openInterest(marketId);
        assertEq(longOi, 0);
        assertEq(shortOi, 0.2e18);
        _assertConservation();
    }

    function test_T004_closeAtProfitTransfersExactlyFromMaker() public {
        _open(trader, 0.2e18, 8_000e6, 1);
        uint256 takerFreeBefore = vault.balanceOf(vault.FREE(), trader);
        uint256 makerCommitBefore = vault.balanceOf(ch.commitDomain(marketId), maker);
        uint256 makerMarginBefore = ch.getPair(marketId, trader).makerMargin;

        _setPrice(66_000);
        uint256 closePx = 66_000 * WAD;
        Types.Quote memory q = _quote(trader, -0.2e18, closePx, 2);
        bytes memory sig = _sign(q);
        vm.prank(trader);
        ch.trade(q, sig, _params(-0.2e18, 0, closePx));

        uint256 pnl = 1_200e6; // 0.2 * 6,000
        uint256 notional = uint256(0.2e18) * 66_000;
        uint256 fee = (notional * 6 / 10_000 + 1e12 - 1) / 1e12;
        assertEq(vault.balanceOf(vault.FREE(), trader), takerFreeBefore + 8_000e6 + pnl - fee, "taker credited");
        assertEq(
            vault.balanceOf(ch.commitDomain(marketId), maker),
            makerCommitBefore + makerMarginBefore - pnl,
            "maker debited by the same integer"
        );
        assertEq(ch.getPair(marketId, trader).size, 0);
        (uint256 longOi,) = ch.openInterest(marketId);
        assertEq(longOi, 0);
        _assertConservation();
    }

    function test_T004_closeAtLossCreditsMaker() public {
        _open(trader, -0.1e18, 4_000e6, 1);
        _setPrice(63_000);
        uint256 closePx = 63_000 * WAD;
        uint256 makerCommitBefore = vault.balanceOf(ch.commitDomain(marketId), maker);
        uint256 makerMargin = ch.getPair(marketId, trader).makerMargin;
        Types.Quote memory q = _quote(trader, 0.1e18, closePx, 2);
        bytes memory sig = _sign(q);
        vm.prank(trader);
        ch.trade(q, sig, _params(0.1e18, 0, closePx));
        assertEq(vault.balanceOf(ch.commitDomain(marketId), maker), makerCommitBefore + makerMargin + 300e6);
        _assertConservation();
    }

    function test_T008_partialReduceRealisesProportionalPnlAndKeepsExposureMatched() public {
        _open(trader, 0.4e18, 16_000e6, 1);
        _setPrice(61_500);
        uint256 rp = 61_500 * WAD;
        Types.Quote memory q = _quote(trader, -0.1e18, rp, 2);
        bytes memory sig = _sign(q);
        vm.prank(trader);
        ch.trade(q, sig, _params(-0.1e18, 0, rp));

        Types.PairView memory v = ch.getPair(marketId, trader);
        assertEq(v.size, 0.3e18);
        assertEq(v.entryPrice, px, "entry unchanged on reduce");
        assertEq(v.realizedPnl, 150e6, "0.1 * 1,500");
        (uint256 longOi,) = ch.openInterest(marketId);
        assertEq(longOi, 0.3e18);
        _assertConservation();
    }

    function test_increaseRecalculatesWeightedEntry() public {
        _open(trader, 0.1e18, 8_000e6, 1);
        _setPrice(62_000);
        uint256 p2 = 62_000 * WAD;
        Types.Quote memory q = _quote(trader, 0.1e18, p2, 2);
        bytes memory sig = _sign(q);
        vm.prank(trader);
        ch.trade(q, sig, _params(0.1e18, 0, p2));
        assertEq(ch.getPair(marketId, trader).entryPrice, 61_000 * WAD);
        _assertConservation();
    }

    function test_flipInOneTradeIsRejected() public {
        _open(trader, 0.1e18, 4_000e6, 1);
        Types.Quote memory q = _quote(trader, -0.2e18, px, 2);
        bytes memory sig = _sign(q);
        vm.prank(trader);
        vm.expectRevert(ClearingHouse.FlipNotAllowed.selector);
        ch.trade(q, sig, _params(-0.2e18, 4_000e6, px));
    }

    function test_overLeverageRejected() public {
        Types.Quote memory q = _quote(trader, 0.2e18, px, 1);
        bytes memory sig = _sign(q);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(ClearingHouse.MarginTooLow.selector, 5_999e6, 6_000e6));
        ch.trade(q, sig, _params(0.2e18, 5_999e6, px));
    }

    function test_makerCapacityExhausted() public {
        _fund(trader, 1_000_000e6);
        _deposit(trader, 1_000_000e6);
        Types.Quote memory q = _quote(trader, 11e18, px, 1);
        bytes memory sig = _sign(q);
        vm.prank(trader);
        vm.expectRevert(ClearingHouse.MakerCapacityExhausted.selector);
        ch.trade(q, sig, _params(11e18, 400_000e6, px));
    }

    function test_quotePriceOutsideOracleBandRejected() public {
        uint256 far = 61_300 * WAD; // +2.17% vs 2.00% band
        Types.Quote memory q = _quote(trader, 0.1e18, far, 1);
        bytes memory sig = _sign(q);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(ClearingHouse.PriceDeviation.selector, far, px));
        ch.trade(q, sig, _params(0.1e18, 4_000e6, far));
    }

    function test_takerLimitPriceProtectsAgainstWorseQuote() public {
        Types.Quote memory q = _quote(trader, 0.1e18, px + 100e18, 1);
        bytes memory sig = _sign(q);
        vm.prank(trader);
        vm.expectRevert(ClearingHouse.LimitPriceExceeded.selector);
        ch.trade(q, sig, _params(0.1e18, 4_000e6, px));
    }

    function test_maxFeeBound() public {
        Types.Quote memory q = _quote(trader, 0.1e18, px, 1);
        bytes memory sig = _sign(q);
        Types.TradeParams memory p = _params(0.1e18, 4_000e6, px);
        p.maxFeeBps = 5;
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(ClearingHouse.FeeAboveMax.selector, 6, 5));
        ch.trade(q, sig, p);
    }

    function test_maxOpenInterestEnforced() public {
        vm.prank(guardian);
        registry.tightenRisk(marketId, 10_000e18, 0);
        Types.Quote memory q = _quote(trader, 0.2e18, px, 1);
        bytes memory sig = _sign(q);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(ClearingHouse.MaxOpenInterest.selector, 12_000e18, 10_000e18));
        ch.trade(q, sig, _params(0.2e18, 8_000e6, px));
    }

    function test_T011_staleOracleBlocksIncreaseButAllowsBackedClose() public {
        _open(trader, 0.1e18, 6_000e6, 1);
        vm.warp(vm.getBlockTimestamp() + 3601);
        assertFalse(oracle.isFresh(FEED_ID));

        Types.Quote memory inc = _quote(trader, 0.1e18, px, 2);
        bytes memory incSig = _sign(inc);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.PriceStale.selector, FEED_ID));
        ch.trade(inc, incSig, _params(0.1e18, 0, px));

        Types.Quote memory dec = _quote(trader, -0.1e18, px, 3);
        bytes memory decSig = _sign(dec);
        vm.prank(trader);
        ch.trade(dec, decSig, _params(-0.1e18, 0, px));
        assertEq(ch.getPair(marketId, trader).size, 0);
        _assertConservation();
    }

    function test_T011_staleOracleTriggersPermissionlessCloseOnly() public {
        vm.warp(vm.getBlockTimestamp() + 3601);
        ch.triggerCloseOnly(marketId);
        assertEq(uint8(registry.getMarket(marketId).perpStatus), uint8(Types.PerpStatus.CLOSE_ONLY));
    }

    function test_triggerCloseOnlyRevertsWhenFeedHealthy() public {
        vm.expectRevert(ClearingHouse.MarketHealthy.selector);
        ch.triggerCloseOnly(marketId);
    }

    function test_closeOnlyBlocksOpenAllowsClose() public {
        _open(trader, 0.1e18, 6_000e6, 1);
        vm.prank(guardian);
        registry.setPerpStatus(marketId, Types.PerpStatus.CLOSE_ONLY);

        Types.Quote memory inc = _quote(trader2, 0.1e18, px, 2);
        bytes memory incSig = _sign(inc);
        vm.prank(trader2);
        vm.expectRevert(abi.encodeWithSelector(ClearingHouse.MarketNotOpen.selector, Types.PerpStatus.CLOSE_ONLY));
        ch.trade(inc, incSig, _params(0.1e18, 6_000e6, px));

        Types.Quote memory dec = _quote(trader, -0.1e18, px, 3);
        bytes memory decSig = _sign(dec);
        vm.prank(trader);
        ch.trade(dec, decSig, _params(-0.1e18, 0, px));
        _assertConservation();
    }

    function test_pausedBlocksEverythingButVaultWithdrawals() public {
        _open(trader, 0.1e18, 6_000e6, 1);
        vm.prank(guardian);
        registry.setPerpStatus(marketId, Types.PerpStatus.PAUSED);
        Types.Quote memory dec = _quote(trader, -0.1e18, px, 2);
        bytes memory decSig = _sign(dec);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(ClearingHouse.MarketNotOpen.selector, Types.PerpStatus.PAUSED));
        ch.trade(dec, decSig, _params(-0.1e18, 0, px));

        uint256 free = vault.balanceOf(vault.FREE(), trader);
        vm.prank(trader);
        vault.withdraw(free, trader);
    }

    function test_guardianCannotReactivate() public {
        vm.startPrank(guardian);
        registry.setPerpStatus(marketId, Types.PerpStatus.CLOSE_ONLY);
        vm.expectRevert(MarketRegistry.TransitionNotAllowed.selector);
        registry.setPerpStatus(marketId, Types.PerpStatus.ACTIVE);
        vm.stopPrank();
    }

    function test_settlementPendingAllowsPermissionlessExitAtMark() public {
        _open(trader, 0.1e18, 6_000e6, 1);
        _setPrice(61_000);
        vm.prank(guardian);
        registry.setPerpStatus(marketId, Types.PerpStatus.SETTLEMENT_PENDING);
        uint256 freeBefore = vault.balanceOf(vault.FREE(), trader);
        vm.prank(liquidator);
        ch.settleAtMark(marketId, trader);
        assertEq(vault.balanceOf(vault.FREE(), trader), freeBefore + 6_000e6 + 100e6);
        assertEq(ch.getPair(marketId, trader).size, 0);
        _assertConservation();
    }

    function test_removeMarginRespectsInitialMargin() public {
        _open(trader, 0.1e18, 6_000e6, 1);
        vm.startPrank(trader);
        ch.removeMargin(marketId, 3_000e6);
        vm.expectRevert(abi.encodeWithSelector(ClearingHouse.MarginTooLow.selector, 2_999_999_999, 3_000e6));
        ch.removeMargin(marketId, 1);
        vm.stopPrank();
        _assertConservation();
    }

    function test_differentMakerCannotIncreaseExistingPair() public {
        _open(trader, 0.1e18, 6_000e6, 1);
        uint256 otherKey = 0xC0FFEE;
        address other = vm.addr(otherKey);
        _fund(other, 100_000e6);
        _deposit(other, 100_000e6);
        vm.prank(other);
        ch.commitBacking(marketId, 50_000e6);
        Types.Quote memory q = _quote(trader, 0.1e18, px, 1);
        q.maker = other;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(otherKey, ch.hashQuote(q));
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(ClearingHouse.MakerMismatch.selector, maker, other));
        ch.trade(q, abi.encodePacked(r, s, v), _params(0.1e18, 6_000e6, px));
    }

    function test_selfTradeRejected() public {
        _deposit(maker, 50_000e6);
        Types.Quote memory q = _quote(maker, 0.1e18, px, 1);
        bytes memory sig = _sign(q);
        vm.prank(maker);
        vm.expectRevert(ClearingHouse.SelfTrade.selector);
        ch.trade(q, sig, _params(0.1e18, 6_000e6, px));
    }

    function test_T013_protocolFeesClaimedOnce() public {
        _open(trader, 0.1e18, 6_000e6, 1);
        uint256 fees = vault.balanceOf(ch.FEES_DOMAIN(), address(0));
        assertEq(fees, 3_600_000);
        vm.prank(feeRecipient);
        ch.claimProtocolFees(feeRecipient);
        assertEq(vault.balanceOf(vault.FREE(), feeRecipient), fees);
        vm.prank(feeRecipient);
        vm.expectRevert(ClearingHouse.NothingToClaim.selector);
        ch.claimProtocolFees(feeRecipient);
        vm.expectRevert(ClearingHouse.NotFeeRecipient.selector);
        ch.claimProtocolFees(address(this));
        _assertConservation();
    }

    function test_T014_pausingOneMarketDoesNotFreezeAnother() public {
        bytes32 second = _secondMarket();
        _open(trader, 0.1e18, 6_000e6, 1);
        vm.prank(guardian);
        registry.setPerpStatus(marketId, Types.PerpStatus.PAUSED);

        Types.Quote memory q = Types.Quote({
            marketId: second,
            maker: maker,
            taker: trader2,
            size: 0.1e18,
            price: px,
            minFill: 0,
            nonce: 77,
            deadline: uint64(vm.getBlockTimestamp() + 30),
            policyVersion: 1
        });
        bytes memory sig = _sign(q);
        vm.prank(trader2);
        ch.trade(q, sig, _params(0.1e18, 6_000e6, px));
        assertEq(ch.getPair(second, trader2).size, 0.1e18);
        _assertConservation();
    }

    function _secondMarket() internal returns (bytes32 id) {
        MockERC20 eth = new MockERC20("Mock ETH (Test asset)", "mETH", 18, 0);
        MockPriceFeed ethFeed = new MockPriceFeed(8, "TEST mETH / USD", admin);
        bytes32 ethFeedId = keccak256("TEST:mETH/USD");
        vm.startPrank(admin);
        ethFeed.setAnswer(int256(BTC_PRICE * 1e8));
        oracle.registerFeed(ethFeedId, address(ethFeed), address(eth), 3600, 1e18, 1e30);
        vm.stopPrank();
        eth.mintTo(creator, 10e18);
        vm.startPrank(creator);
        id = registry.createMarket(address(eth), address(usd), 100);
        registry.proposePerp(id, TIER_B, ethFeedId, 1_000_000e18);
        vault.deposit(MIN_BOND, creator);
        backstop.postBond(id, MIN_BOND);
        vm.stopPrank();
        vm.prank(maker);
        ch.commitBacking(id, MIN_BACKING);
        SpotPool p = SpotPool(registry.getMarket(id).pool);
        vm.startPrank(creator);
        eth.approve(address(p), type(uint256).max);
        usd.approve(address(p), type(uint256).max);
        _seed(p, address(eth), 1e18, 60_000e6, creator);
        vm.stopPrank();
        preflight.activatePerps(id);
    }
}
