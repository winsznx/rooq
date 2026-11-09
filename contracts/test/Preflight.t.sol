// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {Types} from "../src/lib/Types.sol";
import {MarketPreflight} from "../src/market/MarketPreflight.sol";
import {MarketRegistry} from "../src/market/MarketRegistry.sol";
import {MockERC20} from "../src/tokens/MockERC20.sol";
import {SpotPool} from "../src/spot/SpotPool.sol";
import {MockPriceFeed} from "../src/oracle/MockPriceFeed.sol";

/// T09 / T-012: preflight blocks unqualified markets onchain; creator cannot exceed global bounds;
/// activation rechecks live state rather than trusting an earlier "Ready".
contract PreflightTest is Fixture {
    MockERC20 internal meme;
    bytes32 internal constant MEME_FEED = keccak256("TEST:mMEME/USD:approved");

    function setUp() public override {
        super.setUp();
        meme = new MockERC20("Mock Meme (Test asset)", "mMEME", 18, 0);
        meme.mintTo(creator, 1e27);
        MockPriceFeed memeFeed = new MockPriceFeed(8, "TEST mMEME / USD", admin);
        vm.startPrank(admin);
        memeFeed.setAnswer(5e5); // $0.005
        oracle.registerFeed(MEME_FEED, address(memeFeed), address(meme), 3600, 1e14, 1e30);
        vm.stopPrank();
    }

    function test_existingMarketIsActive() public view {
        assertEq(uint8(registry.getMarket(marketId).perpStatus), uint8(Types.PerpStatus.ACTIVE));
        (uint256 mask, Types.PreflightVerdict verdict) = preflight.previewEligibility(marketId);
        assertEq(uint8(verdict), uint8(Types.PreflightVerdict.READY));
        assertEq(mask, preflight.ALL_CHECKS());
    }

    function test_memeWithoutFeedLaunchesSpotOnlyAndPerpsAreBlockedOnchain() public {
        vm.startPrank(creator);
        bytes32 id = registry.createMarket(address(meme), address(usd), 100);
        SpotPool p = SpotPool(registry.getMarket(id).pool);
        meme.approve(address(p), type(uint256).max);
        usd.approve(address(p), type(uint256).max);
        _seed(p, address(meme), 1e24, 5_000e6, creator);
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.FeedNotApproved.selector, keccak256("TEST:MEME/USD")));
        registry.proposePerp(id, TIER_B, keccak256("TEST:MEME/USD"), 10_000e18);
        vm.stopPrank();

        (uint256 mask, Types.PreflightVerdict verdict) = preflight.previewEligibility(id);
        assertEq(uint8(verdict), uint8(Types.PreflightVerdict.NEEDS_FEED));
        assertEq(mask & preflight.CHECK_SPOT_FUNDED(), preflight.CHECK_SPOT_FUNDED(), "spot is ready");
        assertEq(mask & preflight.CHECK_FEED_APPROVED(), 0);

        vm.expectRevert(abi.encodeWithSelector(MarketPreflight.NotEligible.selector, mask));
        preflight.activatePerps(id);
        assertEq(uint8(registry.getMarket(id).perpStatus), uint8(Types.PerpStatus.NONE));
        assertEq(uint8(registry.getMarket(id).spotStatus), uint8(Types.SpotStatus.ACTIVE));
    }

    function test_needsBackingUntilMakerCommits() public {
        bytes32 id = _registerSecond();
        (, Types.PreflightVerdict verdict) = preflight.previewEligibility(id);
        assertEq(uint8(verdict), uint8(Types.PreflightVerdict.NEEDS_BACKING));
        vm.expectRevert();
        preflight.activatePerps(id);

        vm.prank(maker);
        ch.commitBacking(id, MIN_BACKING);
        vm.prank(creator);
        vault.deposit(MIN_BOND, creator);
        vm.prank(creator);
        backstop.postBond(id, MIN_BOND);
        preflight.activatePerps(id);
        assertEq(uint8(registry.getMarket(id).perpStatus), uint8(Types.PerpStatus.ACTIVE));
    }

    function test_activationRechecksLiveFeedState() public {
        bytes32 id = _registerSecond();
        vm.prank(maker);
        ch.commitBacking(id, MIN_BACKING);
        vm.startPrank(creator);
        vault.deposit(MIN_BOND, creator);
        backstop.postBond(id, MIN_BOND);
        vm.stopPrank();
        (, Types.PreflightVerdict verdict) = preflight.previewEligibility(id);
        assertEq(uint8(verdict), uint8(Types.PreflightVerdict.READY));

        vm.warp(vm.getBlockTimestamp() + 3601); // feed goes stale between preview and activation
        vm.expectRevert();
        preflight.activatePerps(id);
    }

    function test_T012_creatorCannotSelectTierOutsideGlobalBounds() public {
        Types.RiskParams memory loose = _tierB();
        loose.imrWad = 0.1e18; // 10x, below the 0.3 global floor
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.OutOfBounds.selector, "imr"));
        registry.setTier(9, loose);

        vm.startPrank(creator);
        bytes32 id = registry.createMarket(address(meme), address(usd), 25);
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.UnknownTier.selector, 9));
        registry.proposePerp(id, 9, FEED_ID, 10_000e18);
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.OutOfBounds.selector, "maxOi"));
        registry.proposePerp(id, TIER_B, FEED_ID, 3_000_000e18);
        vm.stopPrank();
    }

    function test_feedForAnotherAssetCannotBeAttached() public {
        vm.prank(creator);
        bytes32 id = registry.createMarket(address(meme), address(usd), 25);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.FeedAssetMismatch.selector, address(btc), address(meme)));
        registry.proposePerp(id, TIER_B, FEED_ID, 10_000e18);
    }

    function test_onlyCreatorCanProposePerp() public {
        vm.prank(creator);
        bytes32 id = registry.createMarket(address(meme), address(usd), 25);
        vm.prank(trader);
        vm.expectRevert(MarketRegistry.NotCreator.selector);
        registry.proposePerp(id, TIER_B, FEED_ID, 10_000e18);
    }

    function test_duplicateMarketRejected() public {
        vm.prank(creator);
        vm.expectRevert(MarketRegistry.MarketExists.selector);
        registry.createMarket(address(btc), address(usd), 25);
    }

    function test_unapprovedQuoteAssetRejected() public {
        MockERC20 other = new MockERC20("Mock Q (Test)", "mQ", 6, 0);
        vm.prank(creator);
        vm.expectRevert(MarketRegistry.QuoteNotApproved.selector);
        registry.createMarket(address(meme), address(other), 25);
    }

    function test_eoaAsAssetRejected() public {
        vm.prank(creator);
        vm.expectRevert(MarketRegistry.NotAContract.selector);
        registry.createMarket(makeAddr("eoa"), address(usd), 25);
    }

    function test_marketIdIsDeterministic() public view {
        bytes32 expected = keccak256(
            abi.encode(block.chainid, address(registry), address(btc), address(usd), registry.MARKET_CONFIG_VERSION())
        );
        assertEq(marketId, expected);
    }

    function test_previewAssetBeforeAnyGasIsSpent() public view {
        Types.PreflightInput memory input = Types.PreflightInput({
            base: address(meme),
            quote: address(usd),
            feedId: MEME_FEED,
            tierId: TIER_B,
            plannedBacking: MIN_BACKING,
            plannedBond: MIN_BOND,
            plannedSpotQuote: 5_000e6
        });
        (uint256 mask, Types.PreflightVerdict verdict) = preflight.previewAsset(input);
        assertEq(uint8(verdict), uint8(Types.PreflightVerdict.READY));
        assertGt(mask, 0);

        input.feedId = keccak256("TEST:MEME/USD");
        (, verdict) = preflight.previewAsset(input);
        assertEq(uint8(verdict), uint8(Types.PreflightVerdict.NEEDS_FEED));

        input.feedId = FEED_ID; // approved, but it prices mBTC, not this asset
        (, verdict) = preflight.previewAsset(input);
        assertEq(uint8(verdict), uint8(Types.PreflightVerdict.NEEDS_FEED));

        input.feedId = MEME_FEED;
        input.plannedBacking = MIN_BACKING - 1;
        (, verdict) = preflight.previewAsset(input);
        assertEq(uint8(verdict), uint8(Types.PreflightVerdict.NEEDS_BACKING));
    }

    function _registerSecond() internal returns (bytes32 id) {
        vm.startPrank(creator);
        id = registry.createMarket(address(meme), address(usd), 25);
        SpotPool p = SpotPool(registry.getMarket(id).pool);
        meme.approve(address(p), type(uint256).max);
        usd.approve(address(p), type(uint256).max);
        _seed(p, address(meme), 1e24, 5_000e6, creator);
        registry.proposePerp(id, TIER_B, MEME_FEED, 10_000e18);
        vm.stopPrank();
    }
}
