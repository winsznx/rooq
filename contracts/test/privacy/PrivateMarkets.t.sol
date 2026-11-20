// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {MockERC20} from "../../src/tokens/MockERC20.sol";
import {IHonkVerifier} from "../../src/privacy/ShieldedPool.sol";
import {IPriceSource, PrivatePairs} from "../../src/privacy/PrivatePairs.sol";
import {PairTypes} from "../../src/privacy/PairTypes.sol";
import {PrivateMarkets} from "../../src/privacy/PrivateMarkets.sol";
import {PrivacyVerifiers} from "../utils/PrivacyVerifiers.sol";
import {AcceptAllVerifier, CapturingVerifier, Inputs} from "../utils/MockVerifiers.sol";
import {Grumpkin} from "../utils/Grumpkin.sol";
import {MockPriceFeed} from "../../src/oracle/MockPriceFeed.sol";
import {OracleAdapter} from "../../src/oracle/OracleAdapter.sol";

contract Feeds {
    mapping(bytes32 => bool) public isApproved;
    bool public stale;
    uint256 public futureSkew;

    function approve(bytes32 f) external {
        isApproved[f] = true;
    }

    function setStale(bool s) external {
        stale = s;
    }

    function getFreshPrice(bytes32) external view returns (uint256) {
        require(!stale, "stale");
        return 100e18;
    }

    /// @notice Stands in for a price source that reports a round stamped after the block, which OracleAdapter itself refuses.
    function setFutureSkew(uint256 skew) external {
        futureSkew = skew;
    }

    function getPrice(bytes32) external view returns (uint256, uint256, bool) {
        if (futureSkew != 0) return (100e18, block.timestamp + futureSkew, false);
        return (stale ? 0 : 100e18, stale ? 0 : block.timestamp, !stale);
    }
}

/// Market-creation rules that hold before any proof. Proof paths run in e2e/private/offline-liquidation.ts.
contract PrivateMarketsTest is Test {
    bytes32 internal constant FEED = keccak256("F");
    PrivatePairs internal custody;
    PrivateMarkets internal markets;
    MockERC20 internal usd;
    Feeds internal feeds;
    address internal creator = makeAddr("creator");
    address internal scheduler = makeAddr("timelock");
    address internal canceller = makeAddr("safe");
    PairTypes.Verifiers internal v;
    IHonkVerifier internal app;
    IHonkVerifier internal spend;
    IHonkVerifier internal bond;
    IHonkVerifier internal redeem;
    IHonkVerifier internal sweep;
    IHonkVerifier internal pop;

    function setUp() public {
        usd = new MockERC20("Test USDG", "tUSDG", 6, type(uint256).max);
        feeds = new Feeds();
        feeds.approve(FEED);
        v = PrivacyVerifiers.pairs();
        app = PrivacyVerifiers.deploy("AppendVerifier");
        spend = PrivacyVerifiers.deploy("SpendVerifier");
        bond = PrivacyVerifiers.deploy("BondReleaseVerifier");
        redeem = PrivacyVerifiers.deploy("RedeemClaimVerifier");
        sweep = PrivacyVerifiers.deploy("InsuranceSweepVerifier");
        pop = new AcceptAllVerifier();
        (custody, markets) = _deploy(new PairTypes.MarketConfig[](0));
        usd.mintTo(creator, 1_000e6);
        vm.prank(creator);
        usd.approve(address(markets), type(uint256).max);
    }

    function _deploy(PairTypes.MarketConfig[] memory genesis) internal returns (PrivatePairs c, PrivateMarkets m) {
        address[] memory assets = new address[](1);
        assets[0] = address(usd);
        address me = address(this);
        address predicted = vm.computeCreateAddress(me, vm.getNonce(me) + 1);
        c = new PrivatePairs(
            app, spend, assets, v, IPriceSource(address(feeds)), Grumpkin.point(1), [Grumpkin.point(2), Grumpkin.point(3)],
            PairTypes.FeeRecipient(9, Grumpkin.point(4)), genesis, PairTypes.Modules(address(0xdead), predicted, address(0xbeef))
        );
        PrivateMarkets.Tier[] memory tiers = new PrivateMarkets.Tier[](1);
        tiers[0] = PrivateMarkets.Tier(0.1e18, 0.05e18, 1_000_000e18, 10, 100, 0.05e18, 100e18, 10e6, 50);
        m = new PrivateMarkets(c, PrivateMarkets.Verifiers(bond, redeem, sweep, pop), address(usd), tiers, scheduler, canceller, _genesisPops());
    }

    /// Key possession is covered by PrivateMarketsPopTest with real proofs; here an accepting verifier stands in.
    function _genesisPops() internal pure returns (bytes[4] memory pops) {}

    function _pops() internal pure returns (bytes[3] memory pops) {}

    function _create() internal returns (uint256) {
        vm.prank(creator);
        return markets.createMarket(0, FEED, 500_000e18, 20e6);
    }

    function test_createPullsBondIntoCustodyAndRegistersTheMarket() public {
        uint256 id = _create();
        assertEq(id, markets.FIRST_MARKET_ID());
        assertEq(usd.balanceOf(address(custody)), 20e6);
        assertEq(custody.marketBond(id), 20e6);
        assertEq(custody.market(id).imrWad, 0.1e18);
        assertEq(custody.market(id).maxOiUsdWad, 500_000e18);
    }

    function test_createRefusesUnapprovedFeed() public {
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.FeedNotApproved.selector, keccak256("X")));
        vm.prank(creator);
        markets.createMarket(0, keccak256("X"), 1e18, 20e6);
    }

    function test_createRefusesStaleFeed() public {
        feeds.setStale(true);
        vm.expectRevert("stale");
        vm.prank(creator);
        markets.createMarket(0, FEED, 1e18, 20e6);
    }

    function test_oneMarketPerFeed() public {
        _create();
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.FeedAlreadyUsed.selector, FEED));
        vm.prank(creator);
        markets.createMarket(0, FEED, 1e18, 20e6);
    }

    function test_createRefusesSmallBond() public {
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.BondTooSmall.selector, 1e6, 10e6));
        vm.prank(creator);
        markets.createMarket(0, FEED, 1e18, 1e6);
    }

    function test_createRefusesOpenInterestAboveTier() public {
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.OpenInterestAboveTier.selector, 2_000_000e18, 1_000_000e18));
        vm.prank(creator);
        markets.createMarket(0, FEED, 2_000_000e18, 20e6);
    }

    /// Tier: 100 units at $100 is a $10,000 pair, so the market's OI cap must be at least $100,000, the genesis deploy rule.
    function test_createRefusesPairSizeAboveATenthOfMaxOi() public {
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.PairSizeAboveOiShare.selector, 10_000e18, 100_000e18 - 1));
        vm.prank(creator);
        markets.createMarket(0, FEED, 100_000e18 - 1, 20e6);
        vm.prank(creator);
        uint256 id = markets.createMarket(0, FEED, 100_000e18, 20e6);
        assertEq(custody.market(id).maxOiUsdWad, 100_000e18);
    }

    function test_onlyTheCreatorCanClose() public {
        uint256 id = _create();
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.NotCreator.selector, id));
        markets.closeToNewPositions(id);
    }

    function test_bondStaysLockedWhileTheMarketIsOpen() public {
        uint256 id = _create();
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.MarketStillOpen.selector, id));
        markets.releaseBond("", id, 0);
    }

    function test_garbageBondProofReachesTheVerifier() public {
        uint256 id = _create();
        vm.prank(creator);
        markets.closeToNewPositions(id);
        try markets.releaseBond(new bytes(9000), id, 0) {
            revert("garbage proof accepted");
        } catch (bytes memory reason) {
            assertTrue(bytes4(reason) != bytes4(keccak256("Panic(uint256)")), "panicked before the verifier");
        }
        assertEq(usd.balanceOf(creator), 980e6);
    }

    function test_claimCannotBeRedeemedBeforeItIsFolded() public {
        PairTypes.RedeemPublic memory p;
        p.deltaCommitment = bytes32(uint256(9));
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.ClaimNotFolded.selector, p.deltaCommitment));
        markets.redeemClaim("", p);
    }

    function test_insuranceSweepRefusedWhileTheOracleIsAlive() public {
        uint256 id = _create();
        PairTypes.SweepPublic memory p;
        p.market = id;
        vm.warp(block.timestamp + 365 days);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.MarketNotWoundDown.selector, id));
        markets.sweepInsurance("", p);
    }

    function test_insuranceSweepRefusedBeforeTheLongLimit() public {
        uint256 id = _create();
        feeds.setStale(true);
        PairTypes.SweepPublic memory p;
        p.market = id;
        vm.warp(block.timestamp + 89 days);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.MarketNotWoundDown.selector, id));
        markets.sweepInsurance("", p);
    }

    /// Defense in depth: a source reporting a round stamped after the block holds the sweep timer instead of panicking.
    function test_insuranceSweepSaturatesFutureStampedRound() public {
        uint256 id = _create();
        feeds.setFutureSkew(365 days);
        PairTypes.SweepPublic memory p;
        p.market = id;
        vm.warp(block.timestamp + 91 days);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.MarketNotWoundDown.selector, id));
        markets.sweepInsurance("", p);
    }

    function test_garbageSweepProofReachesTheVerifier() public {
        uint256 id = _create();
        feeds.setStale(true);
        PairTypes.SweepPublic memory p;
        p.market = id;
        vm.warp(block.timestamp + 91 days);
        try markets.sweepInsurance(new bytes(9000), p) {
            revert("garbage proof accepted");
        } catch (bytes memory reason) {
            assertTrue(bytes4(reason) != bytes4(keccak256("Panic(uint256)")), "panicked before the verifier");
        }
    }

    // Key rotation (D-24). Valid Grumpkin points: scalar 0xc1, 0xc2, 0xa1, 0xb1 times the generator.
    PairTypes.Point internal coordNew = PairTypes.Point(7383878488757283456466568506289772353621924877086227970372517758408804680004, 5802930315320743836702314590086152220169968915823783245344025467913932850624);
    PairTypes.Point internal coordOther = PairTypes.Point(663258462234762860142666163428333750290175597331148671441960194258598041104, 14993180066769076274746574327130559916173101188695247241939143618246859088743);
    PairTypes.Point internal riskANew = PairTypes.Point(9124757262323539215352237881955954381705512199088184684815032939124361243043, 14310279142516778104749798927487423510175201960957537191292175124999991312425);
    PairTypes.Point internal riskBNew = PairTypes.Point(13069267781790724296328472006122009156900358574745381231177625222181675756826, 17986765245262109738070107056452671877099903295005795585659977915047293729231);

    function _newKeys() internal view returns (PairTypes.KeySet memory) {
        return PairTypes.KeySet(coordNew, riskANew, riskBNew);
    }

    function _currentKeys() internal view returns (PairTypes.KeySet memory) {
        return PairTypes.KeySet(
            PairTypes.Point(custody.coordinatorX(), custody.coordinatorY()), PairTypes.Point(custody.riskAX(), custody.riskAY()), PairTypes.Point(custody.riskBX(), custody.riskBY())
        );
    }

    function _schedule(PairTypes.KeySet memory k) internal {
        vm.prank(scheduler);
        markets.scheduleKeyRotation(k, _pops());
    }

    function test_rotationNeedsTheGuardianAndAnOpenSlot() public {
        vm.expectRevert(PrivateMarkets.NotKeyGuardian.selector);
        markets.scheduleKeyRotation(_newKeys(), _pops());
        _schedule(_newKeys());
        vm.prank(scheduler);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.KeyRotationPending.selector, block.timestamp + 24 hours));
        markets.scheduleKeyRotation(_newKeys(), _pops());
    }

    function test_rotationChangesNothingUntilTheDelayPasses() public {
        PairTypes.KeySet memory before = _currentKeys();
        _schedule(_newKeys());
        assertEq(custody.riskAX(), before.riskA.x, "live key unchanged while scheduled");
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.KeyRotationNotDue.selector, block.timestamp + 24 hours, block.timestamp));
        markets.activateKeyRotation();
        vm.warp(block.timestamp + 24 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.KeyRotationNotDue.selector, block.timestamp + 1, block.timestamp));
        markets.activateKeyRotation();
    }

    function test_anyoneActivatesAfterTheDelayAndHistoryIsKept() public {
        PairTypes.KeySet memory first = _currentKeys();
        _schedule(_newKeys());
        vm.warp(block.timestamp + 24 hours);
        vm.prank(makeAddr("anyone"));
        markets.activateKeyRotation();
        assertEq(custody.coordinatorX(), coordNew.x);
        assertEq(custody.riskAX(), riskANew.x);
        assertEq(custody.riskBY(), riskBNew.y);
        assertEq(markets.keyEpoch(), 1);
        assertEq(markets.keySetAt(0).riskA.x, first.riskA.x, "the retired set stays readable so old records can still be attributed");
        assertEq(markets.keyRotationActivatesAt(), 0);
    }

    function test_cancelClearsTheSchedule() public {
        _schedule(_newKeys());
        vm.prank(makeAddr("anyone"));
        vm.expectRevert(PrivateMarkets.NotKeyGuardian.selector);
        markets.cancelKeyRotation();
        vm.prank(scheduler);
        vm.expectRevert(PrivateMarkets.NotKeyGuardian.selector);
        markets.cancelKeyRotation();
        vm.prank(canceller);
        markets.cancelKeyRotation();
        assertEq(markets.keyRotationActivatesAt(), 0);
        vm.expectRevert(PrivateMarkets.NoKeyRotationPending.selector);
        markets.activateKeyRotation();
    }

    function test_rotationRefusesKeysThatWouldBreakLiquidation() public {
        PairTypes.KeySet memory offCurve = _newKeys();
        offCurve.riskA = PairTypes.Point(1, 1);
        vm.prank(scheduler);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.KeyNotOnCurve.selector, 1, 1));
        markets.scheduleKeyRotation(offCurve, _pops());

        PairTypes.KeySet memory infinity = _newKeys();
        infinity.coordinator = PairTypes.Point(0, 0);
        vm.prank(scheduler);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.KeyNotOnCurve.selector, 0, 0));
        markets.scheduleKeyRotation(infinity, _pops());

        PairTypes.KeySet memory unreduced = _newKeys();
        unreduced.riskB.x = 21888242871839275222246405745257275088548364400416034343698204186575808495618;
        vm.prank(scheduler);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.KeyNotOnCurve.selector, unreduced.riskB.x, unreduced.riskB.y));
        markets.scheduleKeyRotation(unreduced, _pops());
    }

    function test_rotationRefusesDuplicateKeys() public {
        PairTypes.KeySet memory k = _newKeys();
        k.riskB = k.riskA;
        vm.prank(scheduler);
        vm.expectRevert(PrivateMarkets.KeysNotDistinct.selector);
        markets.scheduleKeyRotation(k, _pops());
        PairTypes.KeySet memory same = _currentKeys();
        vm.prank(scheduler);
        vm.expectRevert(PrivateMarkets.NoKeyChange.selector);
        markets.scheduleKeyRotation(same, _pops());
    }

    function test_aRetiredKeyCanNeverComeBack() public {
        _schedule(_newKeys());
        vm.warp(block.timestamp + 24 hours);
        markets.activateKeyRotation();
        PairTypes.KeySet memory back = _currentKeys();
        back.coordinator = coordOther;
        back.riskA = riskBNew;
        vm.prank(scheduler);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.KeyReused.selector, riskBNew.x, riskBNew.y));
        markets.scheduleKeyRotation(back, _pops());
    }

    function test_onlyTheMarketsModuleCanChangeCustodyKeys() public {
        vm.expectRevert(PrivatePairs.NotModule.selector);
        custody.setOperatorKeys(_newKeys());
    }

    function test_aSingleSlotRotationLeavesTheOthersAlone() public {
        PairTypes.KeySet memory k = _currentKeys();
        k.riskA = riskANew;
        _schedule(k);
        vm.warp(block.timestamp + 24 hours);
        markets.activateKeyRotation();
        assertEq(custody.riskAX(), riskANew.x);
        assertEq(custody.riskBX(), Grumpkin.point(3).x, "other risk key untouched");
        assertEq(custody.coordinatorX(), Grumpkin.point(1).x, "coordinator untouched");
    }

    function _genesis(uint256 id, bytes32 feedId) internal view returns (PairTypes.MarketConfig memory) {
        return PairTypes.MarketConfig(id, address(usd), feedId, 0.1e18, 0.05e18, 100, 0.05e18, 10, 1e30, 100e18, 50);
    }

    function _withGenesis() internal returns (PrivatePairs c, PrivateMarkets m) {
        PairTypes.MarketConfig[] memory g = new PairTypes.MarketConfig[](2);
        g[0] = _genesis(1, FEED);
        g[1] = _genesis(99, keccak256("G99"));
        (c, m) = _deploy(g);
    }

    /// Audit #21.
    function test_genesisFeedsMarkedTaken() public {
        (, PrivateMarkets m) = _withGenesis();
        assertTrue(m.feedTaken(FEED));
        assertTrue(m.feedTaken(keccak256("G99")));
        assertFalse(m.feedTaken(keccak256("X")));
    }

    function test_createMarketOnGenesisFeedReverts() public {
        (, PrivateMarkets m) = _withGenesis();
        vm.prank(creator);
        usd.approve(address(m), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.FeedAlreadyUsed.selector, FEED));
        vm.prank(creator);
        m.createMarket(0, FEED, 500_000e18, 20e6);
    }

    function test_duplicateGenesisFeedReverts() public {
        PairTypes.MarketConfig[] memory g = new PairTypes.MarketConfig[](2);
        g[0] = _genesis(1, FEED);
        g[1] = _genesis(2, FEED);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.DuplicateGenesisFeed.selector, FEED));
        this.deployExternal(g);
    }

    function test_genesisIdAtFirstMarketIdReverts() public {
        PairTypes.MarketConfig[] memory g = new PairTypes.MarketConfig[](1);
        g[0] = _genesis(100, FEED);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.GenesisIdCollides.selector, 100));
        this.deployExternal(g);
    }

    /// Lets a test expect a revert from the markets constructor without the custody deployment before it taking the expectation.
    function deployExternal(PairTypes.MarketConfig[] memory g) external {
        _deploy(g);
    }

    function test_closeGenesisMarketOnlyByScheduler() public {
        (PrivatePairs c, PrivateMarkets m) = _withGenesis();
        for (uint256 i; i < 2; i++) {
            vm.prank(i == 0 ? canceller : creator);
            vm.expectRevert(PrivateMarkets.NotKeyGuardian.selector);
            m.closeGenesisMarket(1);
        }
        vm.expectEmit(address(m));
        emit PrivateMarkets.MarketClosedToNewPositions(1);
        vm.prank(scheduler);
        m.closeGenesisMarket(1);
        assertTrue(c.closeOnly(1));
        assertFalse(c.closeOnly(99), "only the named market");
    }

    function test_closeGenesisMarketRefusesCreatedOrUnknownMarkets() public {
        uint256 id = _create();
        vm.startPrank(scheduler);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.NotGenesisMarket.selector, id));
        markets.closeGenesisMarket(id);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.NotGenesisMarket.selector, 5));
        markets.closeGenesisMarket(5);
        vm.stopPrank();
        assertFalse(custody.closeOnly(id), "a creator's market is the creator's to close");
    }

    function test_keyRolesAreSplit() public {
        assertEq(markets.keyScheduler(), scheduler);
        assertEq(markets.keyCanceller(), canceller);
        assertEq(markets.keyGuardian(), scheduler, "legacy reader sees the scheduler");
        vm.prank(canceller);
        vm.expectRevert(PrivateMarkets.NotKeyGuardian.selector);
        markets.scheduleKeyRotation(_newKeys(), _pops());
    }
}

/// Insurance sweep timing against the real adapter and relay feed.
contract PrivateMarketsSweepTimerTest is Test {
    bytes32 internal constant FEED = keccak256("ROOQ:private-v1:CREATABLE/USD");
    PrivatePairs internal custody;
    PrivateMarkets internal markets;
    MockERC20 internal usd;
    MockPriceFeed internal feed;
    address internal creator = makeAddr("creator");

    function setUp() public {
        vm.warp(1_800_000_000);
        usd = new MockERC20("Test USDG", "tUSDG", 6, type(uint256).max);
        feed = new MockPriceFeed(8, "TEST relay creatable / USD", address(this));
        feed.setAnswer(100e8);
        OracleAdapter.FeedInit[] memory g = new OracleAdapter.FeedInit[](1);
        g[0] = OracleAdapter.FeedInit(FEED, address(feed), address(usd), 1 hours, 1e18, 100_000e18);
        OracleAdapter oracle = new OracleAdapter(makeAddr("timelock"), makeAddr("safe"), address(0), 0, g);
        address[] memory assets = new address[](1);
        assets[0] = address(usd);
        IHonkVerifier bond = PrivacyVerifiers.deploy("BondReleaseVerifier");
        IHonkVerifier redeem = PrivacyVerifiers.deploy("RedeemClaimVerifier");
        IHonkVerifier sweep = PrivacyVerifiers.deploy("InsuranceSweepVerifier");
        IHonkVerifier app = PrivacyVerifiers.deploy("AppendVerifier");
        IHonkVerifier spend = PrivacyVerifiers.deploy("SpendVerifier");
        PairTypes.Verifiers memory v = PrivacyVerifiers.pairs();
        IHonkVerifier pop = new AcceptAllVerifier();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        custody = new PrivatePairs(
            app, spend, assets, v, IPriceSource(address(oracle)),
            Grumpkin.point(1), [Grumpkin.point(2), Grumpkin.point(3)], PairTypes.FeeRecipient(9, Grumpkin.point(4)), new PairTypes.MarketConfig[](0),
            PairTypes.Modules(address(0xdead), predicted, address(0xbeef))
        );
        PrivateMarkets.Tier[] memory tiers = new PrivateMarkets.Tier[](1);
        tiers[0] = PrivateMarkets.Tier(0.1e18, 0.05e18, 1_000_000e18, 10, 100, 0.05e18, 100e18, 10e6, 50);
        bytes[4] memory pops;
        markets = new PrivateMarkets(custody, PrivateMarkets.Verifiers(bond, redeem, sweep, pop), address(usd), tiers, makeAddr("timelock"), makeAddr("safe"), pops);
        usd.mintTo(creator, 1_000e6);
        vm.startPrank(creator);
        usd.approve(address(markets), type(uint256).max);
        markets.createMarket(0, FEED, 500_000e18, 20e6);
        vm.stopPrank();
    }

    /// Audit #20: a relay writing out-of-bounds answers every day no longer holds the 90-day sweep timer off.
    function test_sweepTimerIgnoresInvalidRounds() public {
        uint256 t0 = vm.getBlockTimestamp();
        for (uint256 d = 1; d <= 91; d++) {
            vm.warp(t0 + d * 1 days);
            feed.setAnswer(0.5e8);
        }
        PairTypes.SweepPublic memory p;
        p.market = markets.FIRST_MARKET_ID();
        try markets.sweepInsurance(new bytes(9000), p) {
            revert("garbage proof accepted");
        } catch (bytes memory reason) {
            assertTrue(bytes4(reason) != PrivateMarkets.MarketNotWoundDown.selector, "timer held off by invalid rounds");
            assertTrue(bytes4(reason) != bytes4(keccak256("Panic(uint256)")), "panicked before the verifier");
        }
    }

    function test_sweepTimerStillHeldByValidStaleRound() public {
        uint256 t0 = vm.getBlockTimestamp();
        vm.warp(t0 + 30 days);
        feed.setAnswer(101e8);
        vm.warp(t0 + 91 days);
        PairTypes.SweepPublic memory p;
        p.market = markets.FIRST_MARKET_ID();
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.MarketNotWoundDown.selector, p.market));
        markets.sweepInsurance("", p);
    }
}

/// Audit #18 with real key_pop proofs from test/vectors/key_pop/markets, made for custody at 0xC0DE on chain 31337 (deployment id
/// (31337 << 160) | 0xC0DE) with the secrets 0x11..0x15 behind Grumpkin.point(1..5). Custody and markets sit at fixed addresses so
/// the proofs stay valid however the test changes.
contract PrivateMarketsPopTest is Test {
    address internal constant CUSTODY = address(0xC0DE);
    address internal constant MARKETS = address(0xC0DF);
    string internal constant DIR = "test/vectors/key_pop/markets/";
    address internal scheduler = makeAddr("timelock");
    PrivatePairs internal custody;
    PrivateMarkets internal markets;
    MockERC20 internal usd;
    IHonkVerifier internal popV;

    function setUp() public {
        usd = new MockERC20("Test USDG", "tUSDG", 6, type(uint256).max);
        Feeds feeds = new Feeds();
        address[] memory assets = new address[](1);
        assets[0] = address(usd);
        deployCodeTo(
            "PrivatePairs.sol:PrivatePairs",
            abi.encode(
                PrivacyVerifiers.deploy("AppendVerifier"), PrivacyVerifiers.deploy("SpendVerifier"), assets, PrivacyVerifiers.pairs(), address(feeds),
                Grumpkin.point(1), [Grumpkin.point(2), Grumpkin.point(3)], PairTypes.FeeRecipient(9, Grumpkin.point(4)), new PairTypes.MarketConfig[](0),
                PairTypes.Modules(address(0xdead), MARKETS, address(0xbeef))
            ),
            CUSTODY
        );
        custody = PrivatePairs(CUSTODY);
        assertEq(custody.deploymentId(), (uint256(31337) << 160) | uint160(CUSTODY), "proof fixtures are bound to this id");
        popV = PrivacyVerifiers.deploy("KeyPopVerifier");
        deployCodeTo("PrivateMarkets.sol:PrivateMarkets", _args(_genesis()), MARKETS);
        markets = PrivateMarkets(MARKETS);
    }

    function _proof(string memory name) internal view returns (bytes memory) {
        return vm.readFileBinary(string.concat(DIR, name, "/proof"));
    }

    function _genesis() internal view returns (bytes[4] memory pops) {
        pops = [_proof("coordinator"), _proof("risk_a"), _proof("risk_b"), _proof("fee")];
    }

    function _args(bytes[4] memory pops) internal returns (bytes memory) {
        PrivateMarkets.Tier[] memory tiers = new PrivateMarkets.Tier[](0);
        PrivateMarkets.Verifiers memory v = PrivateMarkets.Verifiers(new AcceptAllVerifier(), new AcceptAllVerifier(), new AcceptAllVerifier(), popV);
        return abi.encode(custody, v, address(usd), tiers, scheduler, makeAddr("safe"), pops);
    }

    function deployMarkets(bytes[4] memory pops) external returns (address m) {
        bytes memory code = abi.encodePacked(vm.getCode("PrivateMarkets.sol:PrivateMarkets"), _args(pops));
        assembly {
            m := create(0, add(code, 0x20), mload(code))
            if iszero(m) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }
    }

    function _expectGenesisRefused(bytes[4] memory pops, uint8 slot) internal {
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.MissingPossessionProof.selector, slot));
        this.deployMarkets(pops);
    }

    function test_constructorAcceptsGenesisKeysWithPops() public view {
        assertEq(address(markets.popVerifier()), address(popV));
        assertEq(markets.keyEpoch(), 0);
    }

    function test_constructorRejectsInitialKeyWithoutPop() public {
        bytes[4] memory pops = _genesis();
        pops[0] = "";
        _expectGenesisRefused(pops, 0);
    }

    function test_constructorRejectsFeeKeyWithoutPop() public {
        bytes[4] memory pops = _genesis();
        pops[3] = pops[0];
        _expectGenesisRefused(pops, 3);
    }

    function test_constructorRejectsPopForAnotherSlot() public {
        bytes[4] memory pops = _genesis();
        (pops[1], pops[2]) = (pops[2], pops[1]);
        _expectGenesisRefused(pops, 1);
    }

    function _rotateCoordinator(bytes memory pop) internal {
        PairTypes.KeySet memory k = PairTypes.KeySet(Grumpkin.point(5), Grumpkin.point(2), Grumpkin.point(3));
        bytes[3] memory pops;
        pops[0] = pop;
        vm.prank(scheduler);
        markets.scheduleKeyRotation(k, pops);
    }

    function test_scheduleRequiresPopForEachChangedSlot() public {
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.MissingPossessionProof.selector, 0));
        _rotateCoordinator("");
        _rotateCoordinator(_proof("k5_epoch1_slot0"));
        vm.warp(block.timestamp + 24 hours);
        markets.activateKeyRotation();
        assertEq(custody.coordinatorX(), Grumpkin.point(5).x);
        assertEq(markets.keyEpoch(), 1);
    }

    /// Only the coordinator changes, so the risk entries can be anything.
    function test_scheduleIgnoresPopForUnchangedSlot() public {
        PairTypes.KeySet memory k = PairTypes.KeySet(Grumpkin.point(5), Grumpkin.point(2), Grumpkin.point(3));
        bytes[3] memory pops = [_proof("k5_epoch1_slot0"), bytes("junk"), bytes("")];
        vm.prank(scheduler);
        markets.scheduleKeyRotation(k, pops);
        (uint256 activatesAt,) = markets.pendingKeyRotation();
        assertGt(activatesAt, 0);
    }

    function test_popFromOtherEpochRejected() public {
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.MissingPossessionProof.selector, 0));
        _rotateCoordinator(_proof("k5_epoch0_slot0"));
    }

    function test_popForWrongSlotRejected() public {
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.MissingPossessionProof.selector, 0));
        _rotateCoordinator(_proof("k5_epoch1_slot1"));
    }

    function test_popFromOtherDeploymentRejected() public {
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.MissingPossessionProof.selector, 0));
        _rotateCoordinator(_proof("k5_epoch1_slot0_other_deployment"));
    }

    function test_popInputsMatchTheRegeneratedVerifier() public view {
        bytes32[] memory inputs = new bytes32[](5);
        assertTrue(Inputs.lengthAccepted(popV, inputs));
    }
}

/// #24 option B and the relay fee on redeem, with accepting pair verifiers so funding can make bond use public.
contract PrivateMarketsBondFallbackTest is Test {
    bytes32 internal constant FEED = keccak256("F");
    PrivatePairs internal custody;
    PrivateMarkets internal markets;
    MockERC20 internal usd;
    CapturingVerifier internal epochV;
    CapturingVerifier internal bondV;
    CapturingVerifier internal redeemV;
    address internal creator = makeAddr("creator");
    uint256 internal id;
    uint256 internal nf = 500;

    function setUp() public {
        vm.warp(1_800_000_000);
        usd = new MockERC20("Test USDG", "tUSDG", 6, type(uint256).max);
        Feeds feeds = new Feeds();
        feeds.approve(FEED);
        epochV = new CapturingVerifier();
        bondV = new CapturingVerifier();
        redeemV = new CapturingVerifier();
        IHonkVerifier ok = new AcceptAllVerifier();
        PairTypes.Verifiers memory v = PairTypes.Verifiers(ok, ok, ok, ok, epochV, ok, ok, ok);
        address[] memory assets = new address[](1);
        assets[0] = address(usd);
        IHonkVerifier app = PrivacyVerifiers.deploy("AppendVerifier");
        IHonkVerifier spend = PrivacyVerifiers.deploy("SpendVerifier");
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        custody = new PrivatePairs(
            app, spend, assets, v, IPriceSource(address(feeds)), Grumpkin.point(1), [Grumpkin.point(2), Grumpkin.point(3)],
            PairTypes.FeeRecipient(9, Grumpkin.point(4)), new PairTypes.MarketConfig[](0), PairTypes.Modules(address(0xdead), predicted, address(0xbeef))
        );
        PrivateMarkets.Tier[] memory tiers = new PrivateMarkets.Tier[](1);
        tiers[0] = PrivateMarkets.Tier(0.1e18, 0.05e18, 1_000_000e18, 10, 100, 0.05e18, 100e18, 10e6, 50);
        bytes[4] memory pops;
        markets = new PrivateMarkets(custody, PrivateMarkets.Verifiers(bondV, redeemV, ok, ok), address(usd), tiers, makeAddr("timelock"), makeAddr("safe"), pops);
        usd.mintTo(creator, 1_000e6);
        vm.startPrank(creator);
        usd.approve(address(markets), type(uint256).max);
        id = markets.createMarket(0, FEED, 500_000e18, 20e6);
        vm.stopPrank();
    }

    function _epoch(uint256 bondUsedNext) internal returns (PairTypes.FundingPublic memory p) {
        vm.warp(block.timestamp + 30);
        p.market = id;
        p.asOf = block.timestamp;
        p.bondUsedNext = bondUsedNext;
    }

    function _closeToNew() internal {
        vm.prank(creator);
        markets.closeToNewPositions(id);
    }

    function _pushDelta() internal returns (bytes32 delta) {
        PairTypes.ClosePublic memory c;
        c.root = custody.EMPTY_ROOT();
        c.nullifier = bytes32(++nf);
        c.market = id;
        delta = bytes32(nf + 1000);
        c.deltaCommitment = delta;
        custody.closePair("", c);
    }

    function test_createMarketCarriesTierCloseSpreadCap() public view {
        assertEq(custody.market(id).maxCloseSpreadBps, 50);
        assertEq(markets.tier(0).maxCloseSpreadBps, 50);
    }

    function test_bondFallbackPaysUnusedAfterNotice() public {
        custody.advanceFunding("", _epoch(5e6));
        _closeToNew();
        vm.warp(markets.closedAt(id) + 30 days);
        vm.expectEmit(address(markets));
        emit PrivateMarkets.BondReleasedWithoutProof(id, creator, 15e6, 5e6);
        vm.prank(makeAddr("anyone"));
        markets.releaseBondAfterNotice(id);
        assertEq(usd.balanceOf(creator), 1_000e6 - 20e6 + 15e6);
        assertEq(custody.marketBond(id), 5e6, "custody keeps exactly what was drawn");
    }

    function test_bondFallbackBeforeNoticeReverts() public {
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.MarketStillOpen.selector, id));
        markets.releaseBondAfterNotice(id);
        _closeToNew();
        vm.warp(markets.closedAt(id) + 30 days - 1);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.MarketStillOpen.selector, id));
        markets.releaseBondAfterNotice(id);
    }

    function test_bondFallbackWithPendingDeltasReverts() public {
        _closeToNew();
        _pushDelta();
        vm.warp(markets.closedAt(id) + 30 days);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.MarketStillOpen.selector, id));
        markets.releaseBondAfterNotice(id);
        custody.advanceFunding("", _epoch(0));
        markets.releaseBondAfterNotice(id);
    }

    function test_bondFallbackTwiceAndProofReleaseAfterItRevert() public {
        _closeToNew();
        vm.warp(markets.closedAt(id) + 30 days);
        markets.releaseBondAfterNotice(id);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.BondAlreadyReleased.selector, id));
        markets.releaseBondAfterNotice(id);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.BondAlreadyReleased.selector, id));
        markets.releaseBond("", id, 0);
    }

    function test_epochAfterFallbackCannotDrawBond() public {
        custody.advanceFunding("", _epoch(5e6));
        _closeToNew();
        vm.warp(markets.closedAt(id) + 30 days);
        markets.releaseBondAfterNotice(id);
        epochV.capture(true);
        try custody.advanceFunding("", _epoch(5e6)) {
            revert("not captured");
        } catch (bytes memory r) {
            bytes32[] memory inputs = Inputs.decode(r);
            assertEq(inputs[19], bytes32(uint256(5e6)), "bond_total is now exactly what was used");
            assertEq(inputs[inputs.length - 2], bytes32(uint256(5e6)), "bond_used_prev");
        }
    }

    function test_closedAtNotResetByRepeatClose() public {
        _closeToNew();
        uint256 first = markets.closedAt(id);
        assertEq(first, block.timestamp);
        vm.warp(block.timestamp + 1 days);
        _closeToNew();
        assertEq(markets.closedAt(id), first);
    }

    function test_redeemCreatesRelayFeeLast() public {
        bytes32 delta = _pushDelta();
        custody.advanceFunding("", _epoch(0));
        PairTypes.RedeemPublic memory p;
        p.root = custody.EMPTY_ROOT();
        p.nullifier = bytes32(uint256(9_001));
        p.commitment = bytes32(uint256(9_002));
        p.deltaCommitment = delta;
        p.relayFee.commitment = bytes32(uint256(9_003));
        for (uint256 i; i < 7; i++) p.relayFee.ct[i] = bytes32(9_004 + i);
        redeemV.capture(true);
        try markets.redeemClaim("", p) {
            revert("not captured");
        } catch (bytes memory r) {
            bytes32[] memory inputs = Inputs.decode(r);
            assertEq(inputs[inputs.length - 8], p.relayFee.commitment);
            assertEq(inputs[inputs.length - 1], bytes32(uint256(9_010)));
            assertEq(inputs.length, 21);
            assertTrue(Inputs.lengthAccepted(PrivacyVerifiers.deploy("RedeemClaimVerifier"), inputs));
        }
        redeemV.capture(false);
        vm.recordLogs();
        markets.redeemClaim("", p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 last;
        uint256 created;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] != PrivatePairs.RecordCreated.selector) continue;
            (last,) = abi.decode(logs[i].data, (bytes32, bytes32[]));
            created++;
        }
        assertEq(created, 2);
        assertEq(last, p.relayFee.commitment);
    }
}
