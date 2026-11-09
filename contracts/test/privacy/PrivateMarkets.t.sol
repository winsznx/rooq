// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../../src/tokens/MockERC20.sol";
import {AppendVerifier} from "../../src/privacy/verifiers/AppendVerifier.sol";
import {SpendVerifier} from "../../src/privacy/verifiers/SpendVerifier.sol";
import {LockVerifier} from "../../src/privacy/verifiers/LockVerifier.sol";
import {OpenPairVerifier} from "../../src/privacy/verifiers/OpenPairVerifier.sol";
import {LiquidateVerifier} from "../../src/privacy/verifiers/LiquidateVerifier.sol";
import {ReleaseVerifier} from "../../src/privacy/verifiers/ReleaseVerifier.sol";
import {FundingEpochVerifier} from "../../src/privacy/verifiers/FundingEpochVerifier.sol";
import {ClosePairVerifier} from "../../src/privacy/verifiers/ClosePairVerifier.sol";
import {ExitRequestVerifier} from "../../src/privacy/verifiers/ExitRequestVerifier.sol";
import {PairUpdateVerifier} from "../../src/privacy/verifiers/PairUpdateVerifier.sol";
import {RedeemClaimVerifier} from "../../src/privacy/verifiers/RedeemClaimVerifier.sol";
import {InsuranceSweepVerifier} from "../../src/privacy/verifiers/InsuranceSweepVerifier.sol";
import {BondReleaseVerifier} from "../../src/privacy/verifiers/BondReleaseVerifier.sol";
import {IHonkVerifier} from "../../src/privacy/ShieldedPool.sol";
import {IPriceSource, PrivatePairs} from "../../src/privacy/PrivatePairs.sol";
import {PairTypes} from "../../src/privacy/PairTypes.sol";
import {PrivateMarkets} from "../../src/privacy/PrivateMarkets.sol";

contract Feeds {
    mapping(bytes32 => bool) public isApproved;
    bool public stale;

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

    function getPrice(bytes32) external view returns (uint256, uint256, bool) {
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
    address internal guardian = makeAddr("guardian");

    function setUp() public {
        usd = new MockERC20("Test USDG", "tUSDG", 6, type(uint256).max);
        feeds = new Feeds();
        feeds.approve(FEED);
        address[] memory assets = new address[](1);
        assets[0] = address(usd);
        PairTypes.Verifiers memory v = PairTypes.Verifiers(
            IHonkVerifier(address(new LockVerifier())), IHonkVerifier(address(new OpenPairVerifier())), IHonkVerifier(address(new LiquidateVerifier())),
            IHonkVerifier(address(new ReleaseVerifier())), IHonkVerifier(address(new FundingEpochVerifier())), IHonkVerifier(address(new ClosePairVerifier())),
            IHonkVerifier(address(new ExitRequestVerifier())), IHonkVerifier(address(new PairUpdateVerifier()))
        );
        IHonkVerifier app = IHonkVerifier(address(new AppendVerifier()));
        IHonkVerifier spend = IHonkVerifier(address(new SpendVerifier()));
        IHonkVerifier bond = IHonkVerifier(address(new BondReleaseVerifier()));
        IHonkVerifier redeem = IHonkVerifier(address(new RedeemClaimVerifier()));
        IHonkVerifier sweep = IHonkVerifier(address(new InsuranceSweepVerifier()));
        address me = address(this);
        address predicted = vm.computeCreateAddress(me, vm.getNonce(me) + 1);
        custody = new PrivatePairs(
            app, spend, assets, v, IPriceSource(address(feeds)), PairTypes.Point(1, 2), [PairTypes.Point(3, 4), PairTypes.Point(5, 6)],
            PairTypes.FeeRecipient(9, PairTypes.Point(7, 8)), new PairTypes.MarketConfig[](0), PairTypes.Modules(address(0xdead), predicted)
        );
        PrivateMarkets.Tier[] memory tiers = new PrivateMarkets.Tier[](1);
        tiers[0] = PrivateMarkets.Tier(0.1e18, 0.05e18, 1_000_000e18, 10, 100, 0.05e18, 100e18, 10e6);
        markets = new PrivateMarkets(custody, bond, redeem, sweep, address(usd), tiers, guardian);
        usd.mintTo(creator, 1_000e6);
        vm.prank(creator);
        usd.approve(address(markets), type(uint256).max);
    }

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
        vm.prank(guardian);
        markets.scheduleKeyRotation(k);
    }

    function test_rotationNeedsTheGuardianAndAnOpenSlot() public {
        vm.expectRevert(PrivateMarkets.NotKeyGuardian.selector);
        markets.scheduleKeyRotation(_newKeys());
        _schedule(_newKeys());
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.KeyRotationPending.selector, block.timestamp + 24 hours));
        markets.scheduleKeyRotation(_newKeys());
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
        vm.prank(guardian);
        markets.cancelKeyRotation();
        assertEq(markets.keyRotationActivatesAt(), 0);
        vm.expectRevert(PrivateMarkets.NoKeyRotationPending.selector);
        markets.activateKeyRotation();
    }

    function test_rotationRefusesKeysThatWouldBreakLiquidation() public {
        PairTypes.KeySet memory offCurve = _newKeys();
        offCurve.riskA = PairTypes.Point(1, 1);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.KeyNotOnCurve.selector, 1, 1));
        markets.scheduleKeyRotation(offCurve);

        PairTypes.KeySet memory infinity = _newKeys();
        infinity.coordinator = PairTypes.Point(0, 0);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.KeyNotOnCurve.selector, 0, 0));
        markets.scheduleKeyRotation(infinity);

        PairTypes.KeySet memory unreduced = _newKeys();
        unreduced.riskB.x = 21888242871839275222246405745257275088548364400416034343698204186575808495618;
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.KeyNotOnCurve.selector, unreduced.riskB.x, unreduced.riskB.y));
        markets.scheduleKeyRotation(unreduced);
    }

    function test_rotationRefusesDuplicateKeys() public {
        PairTypes.KeySet memory k = _newKeys();
        k.riskB = k.riskA;
        vm.prank(guardian);
        vm.expectRevert(PrivateMarkets.KeysNotDistinct.selector);
        markets.scheduleKeyRotation(k);
        PairTypes.KeySet memory same = _currentKeys();
        vm.prank(guardian);
        vm.expectRevert(PrivateMarkets.NoKeyChange.selector);
        markets.scheduleKeyRotation(same);
    }

    function test_aRetiredKeyCanNeverComeBack() public {
        _schedule(_newKeys());
        vm.warp(block.timestamp + 24 hours);
        markets.activateKeyRotation();
        PairTypes.KeySet memory back = _currentKeys();
        back.coordinator = coordOther;
        back.riskA = riskBNew;
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(PrivateMarkets.KeyReused.selector, riskBNew.x, riskBNew.y));
        markets.scheduleKeyRotation(back);
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
        assertEq(custody.riskBX(), 5, "other risk key untouched");
        assertEq(custody.coordinatorX(), 1, "coordinator untouched");
    }
}
