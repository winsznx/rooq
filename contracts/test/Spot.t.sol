// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {SpotPool} from "../src/spot/SpotPool.sol";
import {SpotFactory} from "../src/spot/SpotFactory.sol";
import {SpotMath} from "../src/lib/SpotMath.sol";
import {MockERC20} from "../src/tokens/MockERC20.sol";
import {FeeOnTransferToken, ReentrantToken} from "./utils/AdversarialTokens.sol";

/// Spot engine: conservation, minimum liquidity, fee rounding, slippage, deadline, reentrancy,
/// non-standard token rejection and LP share exactness.
contract SpotTest is Fixture {
    address internal lp2 = makeAddr("lp2");

    function setUp() public override {
        super.setUp();
        _fund(trader, 10_000e6);
        vm.startPrank(trader);
        usd.approve(address(pool), type(uint256).max);
        btc.approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    function test_firstDepositLocksMinimumLiquidity() public view {
        assertEq(pool.balanceOf(address(0xdead)), pool.MINIMUM_LIQUIDITY());
        (uint256 r0, uint256 r1) = pool.getReserves();
        assertEq(pool.totalSupply(), SpotMath.sqrt(r0 * r1));
    }

    function test_swapExactInMatchesQuoteAndKeepsInvariant() public {
        (uint256 rIn, uint256 rOut) = _reservesFor(address(usd));
        uint256 quoted = pool.quoteExactIn(address(usd), 6_000e6);
        assertEq(quoted, SpotMath.getAmountOut(6_000e6, rIn, rOut, 25));
        uint256 kBefore = rIn * rOut;

        uint256 balBefore = btc.balanceOf(trader);
        vm.prank(trader);
        uint256 out = pool.swapExactIn(address(usd), 6_000e6, quoted, trader, uint64(vm.getBlockTimestamp() + 60));
        assertEq(out, quoted);
        assertEq(btc.balanceOf(trader), balBefore + out);

        (uint256 r0, uint256 r1) = pool.getReserves();
        assertGe(r0 * r1, kBefore, "k never decreases");
        assertEq(r0, MockERC20(pool.token0()).balanceOf(address(pool)), "reserve0 == balance");
        assertEq(r1, MockERC20(pool.token1()).balanceOf(address(pool)), "reserve1 == balance");
    }

    function test_minOutputEnforced() public {
        uint256 quoted = pool.quoteExactIn(address(usd), 1_000e6);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(SpotPool.InsufficientOutput.selector, quoted, quoted + 1));
        pool.swapExactIn(address(usd), 1_000e6, quoted + 1, trader, uint64(vm.getBlockTimestamp() + 60));
    }

    function test_deadlineEnforced() public {
        vm.prank(trader);
        vm.expectRevert(SpotPool.Expired.selector);
        pool.swapExactIn(address(usd), 1_000e6, 0, trader, uint64(vm.getBlockTimestamp() - 1));
    }

    function test_unknownTokenRejected() public {
        vm.prank(trader);
        vm.expectRevert(SpotPool.InvalidToken.selector);
        pool.swapExactIn(address(0xBEEF), 1, 0, trader, uint64(vm.getBlockTimestamp() + 60));
    }

    function test_zeroOutputRejected() public {
        vm.prank(trader);
        vm.expectRevert(SpotPool.ZeroOutput.selector);
        pool.swapExactIn(address(btc), 1, 0, trader, uint64(vm.getBlockTimestamp() + 60));
    }

    function test_proportionalLpSharesAndExactWithdraw() public {
        btc.mintTo(lp2, 1e18);
        _fund(lp2, 60_000e6);
        vm.startPrank(lp2);
        btc.approve(address(pool), type(uint256).max);
        usd.approve(address(pool), type(uint256).max);
        uint256 supplyBefore = pool.totalSupply();
        uint256 shares = _seed(pool, address(btc), 1e18, 60_000e6, lp2);
        assertEq(shares, supplyBefore / 2, "half the reserves => half the existing shares");

        (uint256 r0, uint256 r1) = pool.getReserves();
        uint256 supply = pool.totalSupply();
        (uint256 o0, uint256 o1) = pool.removeLiquidity(shares, 0, 0, lp2, uint64(vm.getBlockTimestamp() + 60));
        assertEq(o0, shares * r0 / supply);
        assertEq(o1, shares * r1 / supply);
        vm.stopPrank();
    }

    function test_firstDepositorDonationCannotInflateShares() public {
        MockERC20 a = new MockERC20("Mock A (Test)", "mA", 18, 0);
        MockERC20 b = new MockERC20("Mock B (Test)", "mB", 18, 0);
        SpotPool p = SpotPool(factory.createPool(address(a), address(b), 25));
        a.mintTo(address(this), 1e30);
        b.mintTo(address(this), 1e30);
        a.approve(address(p), type(uint256).max);
        b.approve(address(p), type(uint256).max);
        p.addLiquidity(2_000, 2_000, 0, 0, address(this), uint64(vm.getBlockTimestamp() + 60));
        // Donation is not counted in reserves, so it cannot be used to round the next LP down to zero.
        a.transfer(address(p), 1e24);
        b.transfer(address(p), 1e24);
        a.mintTo(lp2, 1e20);
        b.mintTo(lp2, 1e20);
        vm.startPrank(lp2);
        a.approve(address(p), type(uint256).max);
        b.approve(address(p), type(uint256).max);
        (,, uint256 shares) = p.addLiquidity(1e18, 1e18, 0, 0, lp2, uint64(vm.getBlockTimestamp() + 60));
        vm.stopPrank();
        assertGt(shares, 0);
    }

    function test_feeOnTransferTokenRejected() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        MockERC20 b = new MockERC20("Mock B (Test)", "mB", 18, 0);
        SpotPool p = SpotPool(factory.createPool(address(fot), address(b), 25));
        fot.mintTo(address(this), 1e24);
        b.mintTo(address(this), 1e24);
        fot.approve(address(p), type(uint256).max);
        b.approve(address(p), type(uint256).max);
        vm.expectRevert(SpotPool.BalanceDeltaMismatch.selector);
        p.addLiquidity(1e20, 1e20, 0, 0, address(this), uint64(vm.getBlockTimestamp() + 60));
    }

    function test_reentrancyFromTokenCallbackBlocked() public {
        ReentrantToken ren = new ReentrantToken();
        MockERC20 b = new MockERC20("Mock B (Test)", "mB", 18, 0);
        SpotPool p = SpotPool(factory.createPool(address(ren), address(b), 25));
        ren.mintTo(address(this), 1e24);
        b.mintTo(address(this), 1e24);
        ren.approve(address(p), type(uint256).max);
        b.approve(address(p), type(uint256).max);
        p.addLiquidity(1e20, 1e20, 0, 0, address(this), uint64(vm.getBlockTimestamp() + 60));
        ren.arm(address(p));
        vm.expectRevert();
        p.swapExactIn(address(ren), 1e18, 0, address(this), uint64(vm.getBlockTimestamp() + 60));
    }

    function test_duplicatePoolRejected() public {
        vm.expectRevert(SpotFactory.PoolExists.selector);
        factory.createPool(address(usd), address(btc), 25);
    }

    function test_identicalTokensRejected() public {
        vm.expectRevert(SpotFactory.IdenticalTokens.selector);
        factory.createPool(address(usd), address(usd), 25);
    }

    function test_unsupportedFeeTierRejected() public {
        MockERC20 a = new MockERC20("Mock A (Test)", "mA", 18, 0);
        vm.expectRevert(SpotFactory.UnsupportedFee.selector);
        factory.createPool(address(a), address(usd), 33);
    }

    function test_guardianPauseBlocksSwapsButNotWithdrawals() public {
        vm.prank(guardian);
        pool.pause(1);
        vm.prank(trader);
        vm.expectRevert(SpotPool.PoolIsPaused.selector);
        pool.swapExactIn(address(usd), 1_000e6, 0, trader, uint64(vm.getBlockTimestamp() + 60));

        uint256 shares = pool.balanceOf(creator);
        vm.prank(creator);
        pool.removeLiquidity(shares, 0, 0, creator, uint64(vm.getBlockTimestamp() + 60));
    }

    function test_routerSingleHopSwap() public {
        vm.startPrank(trader);
        usd.approve(address(router), type(uint256).max);
        address[] memory path = new address[](2);
        path[0] = address(usd);
        path[1] = address(btc);
        uint16[] memory fees = new uint16[](1);
        fees[0] = 25;
        uint256 quoted = router.quoteExactInput(path, fees, 1_000e6);
        uint256 out = router.swapExactInput(path, fees, 1_000e6, quoted, trader, uint64(vm.getBlockTimestamp() + 60));
        vm.stopPrank();
        assertEq(out, quoted);
        assertEq(usd.balanceOf(address(router)), 0, "router keeps nothing");
        assertEq(btc.balanceOf(address(router)), 0, "router keeps nothing");
    }

    function testFuzz_swapNeverDecreasesK(uint96 amountIn, bool usdIn) public {
        address tokenIn = usdIn ? address(usd) : address(btc);
        uint256 amt = usdIn ? bound(amountIn, 1e6, 9_000e6) : bound(amountIn, 1e14, 0.5e18);
        if (usdIn) _fund(trader, amt);
        else btc.mintTo(trader, amt);
        (uint256 r0, uint256 r1) = pool.getReserves();
        uint256 q = pool.quoteExactIn(tokenIn, amt);
        vm.assume(q > 0);
        vm.prank(trader);
        pool.swapExactIn(tokenIn, amt, q, trader, uint64(vm.getBlockTimestamp() + 60));
        (uint256 n0, uint256 n1) = pool.getReserves();
        assertGe(n0 * n1, r0 * r1);
    }

    function _reservesFor(address tokenIn) internal view returns (uint256 rIn, uint256 rOut) {
        (uint256 r0, uint256 r1) = pool.getReserves();
        (rIn, rOut) = tokenIn == pool.token0() ? (r0, r1) : (r1, r0);
    }
}
