// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockPriceFeed} from "../../src/oracle/MockPriceFeed.sol";
import {OracleAdapter} from "../../src/oracle/OracleAdapter.sol";

contract OracleAdapterTest is Test {
    bytes32 internal constant FEED = keccak256("ROOQ:private-v1:TEST/USD");
    address internal timelock = makeAddr("timelock");
    address internal safe = makeAddr("safe");
    address internal asset = makeAddr("asset");
    MockPriceFeed internal feed;
    OracleAdapter internal oracle;

    function setUp() public {
        vm.warp(1_800_000_000);
        feed = new MockPriceFeed(8, "TEST / USD", address(this));
        feed.setAnswer(250e8);
        oracle = new OracleAdapter(timelock, safe, address(0), 0, _genesis(FEED, address(feed)));
    }

    function _genesis(bytes32 id, address aggregator) internal view returns (OracleAdapter.FeedInit[] memory g) {
        g = new OracleAdapter.FeedInit[](1);
        g[0] = OracleAdapter.FeedInit(id, aggregator, asset, 1 hours, 1e18, 100_000e18);
    }

    function test_genesisFeedsRegisteredInConstructor() public view {
        OracleAdapter.FeedConfig memory f = oracle.feedConfig(FEED);
        assertEq(f.aggregator, address(feed));
        assertEq(f.asset, asset);
        assertEq(f.heartbeat, 1 hours);
        assertEq(f.decimals, 8);
        assertTrue(f.approved);
        assertEq(oracle.getFreshPrice(FEED), 250e18);
    }

    function test_constructorValidatesGenesisFeeds() public {
        OracleAdapter.FeedInit[] memory g = _genesis(FEED, address(feed));
        g[0].heartbeat = 0;
        vm.expectRevert(OracleAdapter.BadConfig.selector);
        new OracleAdapter(timelock, safe, address(0), 0, g);
    }

    function test_registerFeedOnlyAdmin() public {
        MockPriceFeed other = new MockPriceFeed(8, "OTHER / USD", address(this));
        for (uint256 i; i < 2; i++) {
            vm.prank(i == 0 ? safe : address(this));
            vm.expectRevert(OracleAdapter.NotAdmin.selector);
            oracle.registerFeed(keccak256("OTHER"), address(other), asset, 1 hours, 1e18, 1e30);
        }
        vm.prank(timelock);
        oracle.registerFeed(keccak256("OTHER"), address(other), asset, 1 hours, 1e18, 1e30);
        assertTrue(oracle.isApproved(keccak256("OTHER")));
    }

    function test_revokeByGuardianInstant() public {
        vm.prank(makeAddr("anyone"));
        vm.expectRevert(OracleAdapter.NotAdmin.selector);
        oracle.revokeFeed(FEED);
        vm.prank(safe);
        oracle.revokeFeed(FEED);
        assertFalse(oracle.isApproved(FEED));
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.FeedNotApproved.selector, FEED));
        oracle.getFreshPrice(FEED);
        (uint256 price, uint256 updatedAt, bool fresh) = oracle.getPrice(FEED);
        assertEq(abi.encode(price, updatedAt, fresh), abi.encode(0, 0, false), "a revoked feed starts the dead-oracle timer");
    }

    function test_adminCanAlsoRevoke() public {
        vm.prank(timelock);
        oracle.revokeFeed(FEED);
        assertFalse(oracle.isApproved(FEED));
    }

    function test_reinstateOnlyAdmin() public {
        vm.prank(safe);
        oracle.revokeFeed(FEED);
        vm.prank(safe);
        vm.expectRevert(OracleAdapter.NotAdmin.selector);
        oracle.reinstateFeed(FEED);
        vm.prank(timelock);
        oracle.reinstateFeed(FEED);
        assertTrue(oracle.isApproved(FEED));
        assertEq(oracle.getFreshPrice(FEED), 250e18);
    }

    function test_reinstateRefusesLiveOrUnknownFeed() public {
        vm.startPrank(timelock);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.FeedNotRevoked.selector, FEED));
        oracle.reinstateFeed(FEED);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.FeedNotRevoked.selector, keccak256("NONE")));
        oracle.reinstateFeed(keccak256("NONE"));
        vm.stopPrank();
    }

    /// A feed id can never be repointed: reinstating restores the original aggregator and bounds, and registering over it fails.
    function test_reinstateCannotChangeConfig() public {
        OracleAdapter.FeedConfig memory before = oracle.feedConfig(FEED);
        vm.prank(safe);
        oracle.revokeFeed(FEED);
        MockPriceFeed other = new MockPriceFeed(18, "REPOINT", address(this));
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.FeedExists.selector, FEED));
        oracle.registerFeed(FEED, address(other), asset, 7 days, 1, 1e40);
        vm.prank(timelock);
        oracle.reinstateFeed(FEED);
        assertEq(abi.encode(oracle.feedConfig(FEED)), abi.encode(before));
    }

    function _assertInvalid(int256 answer) internal {
        feed.setAnswer(answer);
        (uint256 price, uint256 updatedAt, bool fresh) = oracle.getPrice(FEED);
        assertEq(abi.encode(price, updatedAt, fresh), abi.encode(0, 0, false));
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.PriceInvalid.selector, FEED));
        oracle.getFreshPrice(FEED);
    }

    /// Audit #20: a source that keeps publishing an unusable answer must not look alive to dead-oracle timers.
    function test_invalidAnswerReportsZeroUpdatedAt() public {
        _assertInvalid(0.5e8);
        _assertInvalid(100_001e8);
        _assertInvalid(0);
        _assertInvalid(-1);
    }

    function test_overflowingAnswerReportsZeroUpdatedAt() public {
        MockPriceFeed wide = new MockPriceFeed(0, "WIDE", address(this));
        wide.setAnswer(type(int256).max);
        OracleAdapter o = new OracleAdapter(timelock, safe, address(0), 0, _genesis(FEED, address(wide)));
        (uint256 price, uint256 updatedAt, bool fresh) = o.getPrice(FEED);
        assertEq(abi.encode(price, updatedAt, fresh), abi.encode(0, 0, false));
    }

    function test_staleValidAnswerKeepsUpdatedAt() public {
        uint256 published = block.timestamp;
        vm.warp(block.timestamp + 1 hours + 1);
        (uint256 price, uint256 updatedAt, bool fresh) = oracle.getPrice(FEED);
        assertEq(price, 250e18);
        assertEq(updatedAt, published);
        assertFalse(fresh);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.PriceStale.selector, FEED));
        oracle.getFreshPrice(FEED);
    }

    function test_sequencerDownKeepsUpdatedAt() public {
        MockPriceFeed sequencer = new MockPriceFeed(0, "sequencer uptime", address(this));
        sequencer.setAnswer(1);
        OracleAdapter o = new OracleAdapter(timelock, safe, address(sequencer), 1 hours, _genesis(FEED, address(feed)));
        (uint256 price, uint256 updatedAt, bool fresh) = o.getPrice(FEED);
        assertEq(price, 250e18);
        assertEq(updatedAt, block.timestamp);
        assertFalse(fresh);
    }
}
