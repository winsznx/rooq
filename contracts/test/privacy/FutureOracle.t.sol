// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../../src/tokens/MockERC20.sol";
import {IHonkVerifier, ShieldedPool} from "../../src/privacy/ShieldedPool.sol";
import {IPriceSource, PrivatePairs} from "../../src/privacy/PrivatePairs.sol";
import {PairTypes} from "../../src/privacy/PairTypes.sol";
import {PrivacyVerifiers} from "../utils/PrivacyVerifiers.sol";
import {Grumpkin} from "../utils/Grumpkin.sol";
import {AcceptAllVerifier, RejectAllVerifier} from "../utils/MockVerifiers.sol";
import {OracleAdapter} from "../../src/oracle/OracleAdapter.sol";

/// Aggregator that reports a valid answer stamped in the future (clock skew, a milliseconds-for-seconds bug, a Pyth publishTime
/// ahead of the block).
contract FutureFeed {
    uint256 public skew;
    int256 public answer = 218e8;

    function setSkew(uint256 s) external {
        skew = s;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, block.timestamp + skew, block.timestamp + skew, 1);
    }
}

/// A price source that passes a future `updatedAt` straight through, as a source other than OracleAdapter might.
contract FutureSource is IPriceSource {
    function getFreshPrice(bytes32) external pure returns (uint256) {
        revert("stale");
    }

    function getPrice(bytes32) external view returns (uint256, uint256, bool) {
        return (218e18, block.timestamp + 365 days, false);
    }
}

/// Re-audit finding: a feed stamped ahead of the block used to hand its future `updatedAt` to custody, where
/// `block.timestamp - lastSeen` in `_closeMark` underflowed and the dead-oracle exit panicked for as long as the skew lasted.
contract FutureOracleTest is Test {
    uint256 internal constant MARKET = 1;
    bytes32 internal constant FEED = keccak256("F");
    bytes32 internal constant PAIR = bytes32(uint256(11));
    MockERC20 internal usd;
    PrivatePairs internal pool;
    OracleAdapter internal oracle;
    FutureFeed internal feed;

    function setUp() public {
        vm.warp(1_800_000_000);
        usd = new MockERC20("Test USDG", "tUSDG", 6, type(uint256).max);
        feed = new FutureFeed();
        OracleAdapter.FeedInit[] memory g = new OracleAdapter.FeedInit[](1);
        g[0] = OracleAdapter.FeedInit(FEED, address(feed), address(usd), 1 hours, 1e18, 100_000e18);
        oracle = new OracleAdapter(makeAddr("timelock"), makeAddr("safe"), address(0), 0, g);
        pool = _pool(IPriceSource(address(oracle)));
    }

    function _pool(IPriceSource prices) internal returns (PrivatePairs) {
        PairTypes.Verifiers memory v = PrivacyVerifiers.pairs();
        v.exitRequest = IHonkVerifier(address(new AcceptAllVerifier()));
        v.closePair = IHonkVerifier(address(new RejectAllVerifier()));
        address[] memory assets = new address[](1);
        assets[0] = address(usd);
        PairTypes.MarketConfig[] memory ms = new PairTypes.MarketConfig[](1);
        ms[0] = PairTypes.MarketConfig(MARKET, address(usd), FEED, 0.1e18, 0.05e18, 100, 0.05e18, 10, 1e30, 100e18, 50);
        return new PrivatePairs(
            PrivacyVerifiers.deploy("AppendVerifier"), PrivacyVerifiers.deploy("SpendVerifier"), assets, v, prices, Grumpkin.point(1),
            [Grumpkin.point(2), Grumpkin.point(3)], PairTypes.FeeRecipient(9, Grumpkin.point(4)), ms, PairTypes.Modules(address(this), address(this), address(this))
        );
    }

    function _deadClose(PrivatePairs p_) internal view returns (PairTypes.ClosePublic memory p) {
        p.root = p_.EMPTY_ROOT();
        p.nullifier = PAIR;
        p.market = MARKET;
        p.mode = 2;
    }

    function test_futureStampedRoundIsInvalid() public {
        feed.setSkew(1);
        (uint256 price, uint256 updatedAt, bool fresh) = oracle.getPrice(FEED);
        assertEq(price, 0);
        assertEq(updatedAt, 0);
        assertFalse(fresh);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.PriceInvalid.selector, FEED));
        oracle.getFreshPrice(FEED);

        feed.setSkew(0);
        (price, updatedAt, fresh) = oracle.getPrice(FEED);
        assertEq(price, 218e18);
        assertEq(updatedAt, block.timestamp);
        assertTrue(fresh);
    }

    /// The future-stamped feed no longer holds the timer: 14 days with no usable price opens the dead-oracle exit, which reaches
    /// the (rejecting) verifier instead of panicking. Taker and matured closes still refuse the unusable price.
    function test_futureStampedFeedOpensDeadOracleExit() public {
        feed.setSkew(365 days);
        pool.requestExit{value: pool.EXIT_BOND()}("", pool.EMPTY_ROOT(), PAIR);
        vm.warp(block.timestamp + 60 days);

        PairTypes.ClosePublic memory p = _deadClose(pool);
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.closePair("", p);

        p.mode = 1;
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.OracleUnavailable.selector, MARKET));
        pool.closePair("", p);
    }

    /// Defense in depth for sources other than OracleAdapter: a future `updatedAt` saturates to "seen now" and holds the timer
    /// with OracleNotDead rather than an arithmetic panic.
    function test_closeMarkSaturatesFutureUpdatedAt() public {
        PrivatePairs direct = _pool(new FutureSource());
        direct.requestExit{value: direct.EXIT_BOND()}("", direct.EMPTY_ROOT(), PAIR);
        vm.warp(block.timestamp + 60 days);
        PairTypes.ClosePublic memory p = _deadClose(direct);
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.OracleNotDead.selector, MARKET));
        direct.closePair("", p);
    }

    /// Control: a valid round stamped now still holds the timer (by design).
    function test_validRoundStampedNowHoldsTimer() public {
        pool.requestExit{value: pool.EXIT_BOND()}("", pool.EMPTY_ROOT(), PAIR);
        vm.warp(block.timestamp + 15 days);
        PairTypes.ClosePublic memory p = _deadClose(pool);
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.OracleNotDead.selector, MARKET));
        pool.closePair("", p);
    }
}
