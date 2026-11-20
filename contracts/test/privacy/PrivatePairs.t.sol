// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {MockERC20} from "../../src/tokens/MockERC20.sol";
import {IHonkVerifier, ShieldedPool} from "../../src/privacy/ShieldedPool.sol";
import {IPriceSource, PrivatePairs} from "../../src/privacy/PrivatePairs.sol";
import {PairTypes} from "../../src/privacy/PairTypes.sol";
import {PrivacyVerifiers} from "../utils/PrivacyVerifiers.sol";
import {Grumpkin} from "../utils/Grumpkin.sol";
import {AcceptAllVerifier, CapturingVerifier, Inputs, RejectAllVerifier} from "../utils/MockVerifiers.sol";
import {MockPriceFeed} from "../../src/oracle/MockPriceFeed.sol";
import {OracleAdapter} from "../../src/oracle/OracleAdapter.sol";

contract StubOracle is IPriceSource {
    uint256 public price = 218e18;
    bool public stale;

    error PriceStale();

    function setStale(bool s) external {
        stale = s;
    }

    function getFreshPrice(bytes32) external view returns (uint256) {
        if (stale) revert PriceStale();
        return price;
    }

    function getPrice(bytes32) external view returns (uint256, uint256, bool) {
        return (stale ? 0 : price, stale ? 0 : block.timestamp, !stale);
    }
}

/// Checks that hold before any proof is verified. Paths that need real proofs run in
/// e2e/private/offline-liquidation.ts.
contract PrivatePairsTest is Test {
    uint256 internal constant MARKET = 1;
    PrivatePairs internal pool;
    MockERC20 internal usd;
    StubOracle internal oracle;
    PairTypes.Verifiers internal v;
    IHonkVerifier internal appendV;
    IHonkVerifier internal spendV;
    address[] internal assets;

    function setUp() public {
        usd = new MockERC20("Test USDG", "tUSDG", 6, type(uint256).max);
        oracle = new StubOracle();
        assets.push(address(usd));
        appendV = PrivacyVerifiers.deploy("AppendVerifier");
        spendV = PrivacyVerifiers.deploy("SpendVerifier");
        v = PrivacyVerifiers.pairs();
        pool = _deploy(_config(MARKET, address(usd), 0.1e18, 0.05e18, 100), _pt(1), _pt(2), _pt(3));
    }

    function _pt(uint256 i) internal pure returns (PairTypes.Point memory) {
        return Grumpkin.point(i);
    }

    function _config(uint256 id, address asset, uint256 imr, uint256 mmr, uint256 penalty)
        internal
        pure
        returns (PairTypes.MarketConfig[] memory ms)
    {
        ms = new PairTypes.MarketConfig[](1);
        ms[0] = PairTypes.MarketConfig(id, asset, keccak256("F"), imr, mmr, penalty, 0.05e18, 10, 1e30, 100e18, 50);
    }

    function _deploy(
        PairTypes.MarketConfig[] memory ms,
        PairTypes.Point memory coordinator,
        PairTypes.Point memory a,
        PairTypes.Point memory b
    ) internal returns (PrivatePairs) {
        return new PrivatePairs(appendV, spendV, assets, v, IPriceSource(address(oracle)), coordinator, [a, b], PairTypes.FeeRecipient(9, _pt(4)), ms, PairTypes.Modules(address(this), address(this), address(this)));
    }

    function test_marketScaleComesFromTokenDecimals() public view {
        assertEq(pool.market(MARKET).scale, 1e12);
    }

    function test_constructorRejectsUnsupportedMarketAsset() public {
        address other = address(new MockERC20("O", "O", 6, 1));
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.BadMarketConfig.selector, MARKET));
        _deploy(_config(MARKET, other, 0.1e18, 0.05e18, 100), _pt(1), _pt(2), _pt(3));
    }

    function test_constructorRejectsMaintenanceAtOrAboveInitial() public {
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.BadMarketConfig.selector, MARKET));
        _deploy(_config(MARKET, address(usd), 0.05e18, 0.05e18, 100), _pt(1), _pt(2), _pt(3));
    }

    function test_constructorRejectsMarketIdOutsideField() public {
        uint256 id = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.BadMarketConfig.selector, id));
        _deploy(_config(id, address(usd), 0.1e18, 0.05e18, 100), _pt(1), _pt(2), _pt(3));
    }

    function test_constructorRejectsOffCurveFeeKey() public {
        PairTypes.Point memory off = PairTypes.Point(7, 8);
        vm.expectRevert(PrivatePairs.BadKey.selector);
        new PrivatePairs(appendV, spendV, assets, v, IPriceSource(address(oracle)), _pt(1), [_pt(2), _pt(3)], PairTypes.FeeRecipient(9, off), _config(MARKET, address(usd), 0.1e18, 0.05e18, 100), PairTypes.Modules(address(this), address(this), address(this)));
    }

    function test_constructorRejectsOffCurveOperatorKey() public {
        PairTypes.Point memory unreduced = _pt(2);
        unreduced.x += 21888242871839275222246405745257275088548364400416034343698204186575808495617;
        PairTypes.Point[3] memory bad = [PairTypes.Point(1, 2), PairTypes.Point(0, 0), unreduced];
        for (uint256 i; i < 3; i++) {
            vm.expectRevert(PrivatePairs.BadKey.selector);
            _deploy(_config(MARKET, address(usd), 0.1e18, 0.05e18, 100), bad[i], _pt(2), _pt(3));
            vm.expectRevert(PrivatePairs.BadKey.selector);
            _deploy(_config(MARKET, address(usd), 0.1e18, 0.05e18, 100), _pt(1), bad[i], _pt(3));
            vm.expectRevert(PrivatePairs.BadKey.selector);
            _deploy(_config(MARKET, address(usd), 0.1e18, 0.05e18, 100), _pt(1), _pt(2), bad[i]);
        }
    }

    /// EIP-170 allows 24,576 bytes. Keep a kilobyte free so the next fix does not force a redesign.
    function test_privatePairsRuntimeUnderLimit() public view {
        uint256 size = vm.getDeployedCode("PrivatePairs.sol:PrivatePairs").length;
        assertEq(address(pool).code.length, size);
        assertLe(size + 1024, 24_576, "PrivatePairs runtime leaves less than 1 KB under EIP-170");
    }

    function test_recordCreatedEventIsPinned() public pure {
        assertEq(PrivatePairs.RecordCreated.selector, keccak256("RecordCreated(uint256,uint8,bytes32,bytes32[])"));
    }

    function test_constructorRejectsOneWorkerUsedTwice() public {
        vm.expectRevert(PrivatePairs.BadKey.selector);
        _deploy(_config(MARKET, address(usd), 0.1e18, 0.05e18, 100), _pt(1), _pt(2), _pt(2));
    }

    function _liq() internal view returns (PairTypes.LiquidatePublic memory p) {
        p.root = pool.EMPTY_ROOT();
        p.nullifier = bytes32(uint256(5));
        p.market = MARKET;
    }

    function test_liquidateRejectsUnknownMarket() public {
        PairTypes.LiquidatePublic memory p = _liq();
        p.market = 9;
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.UnknownMarket.selector, 9));
        pool.liquidate("", p);
    }

    function test_liquidateRejectsUnknownRoot() public {
        PairTypes.LiquidatePublic memory p = _liq();
        p.root = bytes32(uint256(77));
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.UnknownRoot.selector, p.root));
        pool.liquidate("", p);
    }

    /// LIQ-08: a stale oracle cannot liquidate.
    function test_liquidateFailsClosedOnStaleOracle() public {
        oracle.setStale(true);
        PairTypes.LiquidatePublic memory p = _liq();
        vm.expectRevert(StubOracle.PriceStale.selector);
        pool.liquidate("", p);
    }

    function test_openFailsClosedOnStaleOracle() public {
        oracle.setStale(true);
        PairTypes.OpenPublic memory p;
        p.root = pool.EMPTY_ROOT();
        p.market = MARKET;
        p.asOf = block.timestamp;
        p.nullifiers[0] = bytes32(uint256(1));
        p.nullifiers[1] = bytes32(uint256(2));
        vm.expectRevert(StubOracle.PriceStale.selector);
        pool.openPair("", p);
    }

    /// A panic here means the public-input array was built wrong, which an expectRevert would have hidden.
    function _assertVerifierRefused(bytes memory reason) internal pure {
        assertTrue(bytes4(reason) != bytes4(keccak256("Panic(uint256)")), "panicked before reaching the verifier");
        assertTrue(reason.length >= 4, "reverted without a verifier error");
    }

    function test_garbageLiquidationProofLeavesPairLive() public {
        PairTypes.LiquidatePublic memory p = _liq();
        try pool.liquidate(new bytes(9000), p) {
            revert("garbage proof accepted");
        } catch (bytes memory reason) {
            _assertVerifierRefused(reason);
        }
        assertFalse(pool.nullifierSpent(p.nullifier));
    }

    function test_garbageOpenProofReachesTheVerifier() public {
        PairTypes.OpenPublic memory p;
        p.root = pool.EMPTY_ROOT();
        p.market = MARKET;
        p.asOf = block.timestamp;
        p.nullifiers[0] = bytes32(uint256(1));
        p.nullifiers[1] = bytes32(uint256(2));
        try pool.openPair(new bytes(9000), p) {
            revert("garbage proof accepted");
        } catch (bytes memory reason) {
            _assertVerifierRefused(reason);
        }
    }

    function test_openRejectsPastAsOf() public {
        vm.warp(1000);
        PairTypes.OpenPublic memory p;
        p.root = pool.EMPTY_ROOT();
        p.market = MARKET;
        p.asOf = 999;
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.StaleAsOf.selector, 999, 1000));
        pool.openPair("", p);
    }

    function test_releaseRejectsFutureAsOf() public {
        vm.warp(1000);
        PairTypes.ReleasePublic memory p;
        p.root = pool.EMPTY_ROOT();
        p.asOf = 1001;
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.StaleAsOf.selector, 1001, 1000));
        pool.release("", p);
    }

    /// LIQ-08: stale funding blocks new exposure, and only new exposure.
    function test_openRefusedWhenFundingIsStale() public {
        vm.warp(block.timestamp + 1 hours + 1);
        PairTypes.OpenPublic memory p;
        p.root = pool.EMPTY_ROOT();
        p.market = MARKET;
        p.asOf = block.timestamp;
        uint256 last = pool.funding(MARKET).lastEpoch;
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.FundingStale.selector, last, block.timestamp));
        pool.openPair("", p);
    }

    function test_liquidationIsNotBlockedByStaleFunding() public {
        vm.warp(block.timestamp + 30 days);
        PairTypes.LiquidatePublic memory p = _liq();
        try pool.liquidate(new bytes(9000), p) {
            revert("garbage proof accepted");
        } catch (bytes memory reason) {
            assertTrue(bytes4(reason) != PrivatePairs.FundingStale.selector, "liquidation gated on funding");
            _assertVerifierRefused(reason);
        }
    }

    function _epoch(uint256 asOf) internal pure returns (PairTypes.FundingPublic memory p) {
        p.market = MARKET;
        p.asOf = asOf;
    }

    function test_epochRejectsTimestampsOutsideItsWindow() public {
        vm.warp(10_000);
        pool = _deploy(_config(MARKET, address(usd), 0.1e18, 0.05e18, 100), _pt(1), _pt(2), _pt(3));
        vm.warp(20_000);
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.StaleAsOf.selector, 20_001, 20_000));
        pool.advanceFunding("", _epoch(20_001));
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.StaleAsOf.selector, 19_000, 20_000));
        pool.advanceFunding("", _epoch(19_000));
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.StaleAsOf.selector, 10_000, 20_000));
        pool.advanceFunding("", _epoch(10_000));
    }

    function test_garbageEpochProofChangesNothing() public {
        vm.warp(block.timestamp + 100);
        PairTypes.FundingPublic memory p = _epoch(block.timestamp);
        p.indexMag = 1e18;
        try pool.advanceFunding(new bytes(9000), p) {
            revert("garbage proof accepted");
        } catch (bytes memory reason) {
            _assertVerifierRefused(reason);
        }
        assertEq(pool.funding(MARKET).index, pool.FUNDING_INDEX_ZERO());
    }

    function _close(uint256 mode) internal view returns (PairTypes.ClosePublic memory p) {
        p.root = pool.EMPTY_ROOT();
        p.nullifier = bytes32(uint256(11));
        p.market = MARKET;
        p.mode = mode;
    }

    /// REC-05: no fresh price, no ordinary close.
    function test_takerCloseFailsClosedOnStaleOracle() public {
        oracle.setStale(true);
        PairTypes.ClosePublic memory p = _close(0);
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.OracleUnavailable.selector, MARKET));
        pool.closePair("", p);
    }

    function test_forcedCloseNeedsARequest() public {
        PairTypes.ClosePublic memory p = _close(1);
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.ExitNotMature.selector, p.nullifier));
        pool.closePair("", p);
    }

    function test_deadOracleCloseNeedsARequest() public {
        oracle.setStale(true);
        PairTypes.ClosePublic memory p = _close(2);
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.ExitNotMature.selector, p.nullifier));
        pool.closePair("", p);
    }

    function test_garbageCloseProofReachesTheVerifier() public {
        PairTypes.ClosePublic memory p = _close(0);
        try pool.closePair(new bytes(9000), p) {
            revert("garbage proof accepted");
        } catch (bytes memory reason) {
            _assertVerifierRefused(reason);
        }
        assertFalse(pool.nullifierSpent(p.nullifier));
    }

    function test_exitRequestNeedsTheExactBond() public {
        bytes32 root = pool.EMPTY_ROOT();
        vm.expectRevert(PrivatePairs.BadBond.selector);
        pool.requestExit("", root, bytes32(uint256(1)));
    }

    function test_garbageExitRequestReachesTheVerifierAndStoresNothing() public {
        bytes32 root = pool.EMPTY_ROOT();
        uint256 bond = pool.EXIT_BOND();
        try pool.requestExit{value: bond}(new bytes(9000), root, bytes32(uint256(1))) {
            revert("garbage proof accepted");
        } catch (bytes memory reason) {
            _assertVerifierRefused(reason);
        }
        (address requester,) = pool.exitRequests(bytes32(uint256(1)));
        assertEq(requester, address(0));
    }

    function _update() internal view returns (PairTypes.UpdatePublic memory p) {
        p.root = pool.EMPTY_ROOT();
        p.market = MARKET;
        p.nullifiers[0] = bytes32(uint256(21));
        p.nullifiers[1] = bytes32(uint256(22));
    }

    function test_garbageUpdateProofReachesTheVerifierEvenWithAStaleOracle() public {
        oracle.setStale(true);
        PairTypes.UpdatePublic memory p = _update();
        try pool.updatePair(new bytes(9000), p) {
            revert("garbage proof accepted");
        } catch (bytes memory reason) {
            _assertVerifierRefused(reason);
        }
        assertFalse(pool.nullifierSpent(p.nullifiers[0]));
    }

    function test_constructorRejectsZeroMaxPairSize() public {
        PairTypes.MarketConfig[] memory ms = _config(MARKET, address(usd), 0.1e18, 0.05e18, 100);
        ms[0].maxPairSize = 0;
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.BadMarketConfig.selector, MARKET));
        _deploy(ms, _pt(1), _pt(2), _pt(3));
    }

    function test_onlyTheSpotModuleCanTouchRecords() public {
        vm.prank(address(0xbad));
        vm.expectRevert(PrivatePairs.NotSpotModule.selector);
        pool.moduleConsume(bytes32(uint256(1)));
        vm.prank(address(0xbad));
        vm.expectRevert(PrivatePairs.NotSpotModule.selector);
        pool.moduleCreate(1, bytes32(uint256(1)), new bytes32[](0));
    }

    function test_spotModuleConsumesOnce() public {
        pool.moduleConsume(bytes32(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NullifierSpent.selector, bytes32(uint256(1))));
        pool.moduleConsume(bytes32(uint256(1)));
    }

    function test_closeOnlyStopsNewPositionsOnly() public {
        pool.setCloseOnly(MARKET);
        PairTypes.OpenPublic memory p;
        p.root = pool.EMPTY_ROOT();
        p.market = MARKET;
        p.asOf = block.timestamp;
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.MarketCloseOnly.selector, MARKET));
        pool.openPair("", p);
        assertTrue(pool.closeOnly(MARKET));
    }

    function test_marketControlsAreModuleOnly() public {
        vm.prank(address(0xbad));
        vm.expectRevert(PrivatePairs.NotModule.selector);
        pool.setCloseOnly(MARKET);
        vm.prank(address(0xbad));
        vm.expectRevert(PrivatePairs.NotModule.selector);
        pool.payBond(MARKET, address(0xbad), 0);
    }

    function test_bondCannotBeReclaimedWhileThePairIsLive() public {
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.PairStillLive.selector, bytes32(uint256(1))));
        pool.reclaimExitBond(bytes32(uint256(1)));
    }

    function test_lockRejectsRepeatedNullifierInOneCall() public {
        PairTypes.LockPublic memory p;
        p.root = pool.EMPTY_ROOT();
        p.nullifiers[0] = bytes32(uint256(1));
        p.nullifiers[1] = bytes32(uint256(1));
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NullifierSpent.selector, bytes32(uint256(1))));
        pool.lock("", p);
    }
}

/// Dead-oracle and heartbeat rules against the real adapter and relay feed. Exit requests use an accepting verifier and closes a
/// rejecting one, so reaching the close verifier means the oracle gate opened.
contract PrivatePairsOracleTest is Test {
    uint256 internal constant MARKET = 1;
    bytes32 internal constant FEED = keccak256("ROOQ:private-v1:TEST/USD");
    bytes32 internal constant PAIR = bytes32(uint256(11));
    PrivatePairs internal pool;
    MockERC20 internal usd;
    MockPriceFeed internal feed;
    OracleAdapter internal oracle;
    uint256 internal t0;

    function setUp() public {
        vm.warp(1_800_000_000);
        usd = new MockERC20("Test USDG", "tUSDG", 6, type(uint256).max);
        feed = new MockPriceFeed(8, "TEST relay / USD", address(this));
        feed.setAnswer(218e8);
        _deployAt(block.timestamp);
    }

    function _deployAt(uint256 t) internal {
        vm.warp(t);
        t0 = t;
        OracleAdapter.FeedInit[] memory g = new OracleAdapter.FeedInit[](1);
        g[0] = OracleAdapter.FeedInit(FEED, address(feed), address(usd), 1 hours, 1e18, 100_000e18);
        oracle = new OracleAdapter(makeAddr("timelock"), makeAddr("safe"), address(0), 0, g);
        PairTypes.Verifiers memory v = PrivacyVerifiers.pairs();
        v.exitRequest = IHonkVerifier(address(new AcceptAllVerifier()));
        v.closePair = IHonkVerifier(address(new RejectAllVerifier()));
        address[] memory assets = new address[](1);
        assets[0] = address(usd);
        PairTypes.MarketConfig[] memory ms = new PairTypes.MarketConfig[](1);
        ms[0] = PairTypes.MarketConfig(MARKET, address(usd), FEED, 0.1e18, 0.05e18, 100, 0.05e18, 10, 1e30, 100e18, 50);
        pool = new PrivatePairs(
            PrivacyVerifiers.deploy("AppendVerifier"), PrivacyVerifiers.deploy("SpendVerifier"), assets, v, IPriceSource(address(oracle)), Grumpkin.point(1),
            [Grumpkin.point(2), Grumpkin.point(3)], PairTypes.FeeRecipient(9, Grumpkin.point(4)), ms, PairTypes.Modules(address(this), address(this), address(this))
        );
    }

    function _requestExit() internal {
        pool.requestExit{value: pool.EXIT_BOND()}("", pool.EMPTY_ROOT(), PAIR);
    }

    /// The relay keeps writing `answer` once a day until `day` days after deployment.
    function _publishDailyUntil(int256 answer, uint256 day) internal {
        for (uint256 d = 1; d <= day; d++) {
            vm.warp(t0 + d * 1 days);
            feed.setAnswer(answer);
        }
    }

    function _deadClose() internal view returns (PairTypes.ClosePublic memory p) {
        p.root = pool.EMPTY_ROOT();
        p.nullifier = PAIR;
        p.market = MARKET;
        p.mode = 2;
    }

    function _assertOracleDead() internal {
        PairTypes.ClosePublic memory p = _deadClose();
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.closePair("", p);
    }

    function _assertOracleNotDead() internal {
        PairTypes.ClosePublic memory p = _deadClose();
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.OracleNotDead.selector, MARKET));
        pool.closePair("", p);
    }

    function test_deadOracleTimerRunsWhileFeedPublishesBelowMin() public {
        _requestExit();
        _publishDailyUntil(0.5e8, 15);
        _assertOracleDead();
    }

    function test_deadOracleTimerRunsWhileFeedPublishesZero() public {
        _requestExit();
        _publishDailyUntil(0, 15);
        _assertOracleDead();
    }

    function test_deadOracleTimerRunsWhileFeedPublishesNegative() public {
        _requestExit();
        _publishDailyUntil(-218e8, 15);
        _assertOracleDead();
    }

    function test_silentRelayStillDiesAfter14Days() public {
        _requestExit();
        vm.warp(t0 + 14 days - 1);
        _assertOracleNotDead();
        vm.warp(t0 + 14 days);
        _assertOracleDead();
    }

    /// A usable but stale round is still a real price; the timer runs from it.
    function test_validStaleRoundStillHoldsTimer() public {
        _requestExit();
        vm.warp(t0 + 10 days);
        feed.setAnswer(220e8);
        vm.warp(t0 + 15 days);
        _assertOracleNotDead();
        vm.warp(t0 + 24 days);
        _assertOracleDead();
    }

    /// Audit #22: the last price must be younger than the one-hour heartbeat for new exposure. Funding is fresh here, so
    /// only the oracle can refuse.
    function test_openRefusesPriceOlderThanHeartbeat() public {
        _deployAt(block.timestamp + 1 hours + 1);
        PairTypes.OpenPublic memory p;
        p.root = pool.EMPTY_ROOT();
        p.market = MARKET;
        p.asOf = block.timestamp;
        p.nullifiers[0] = bytes32(uint256(1));
        p.nullifiers[1] = bytes32(uint256(2));
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.PriceStale.selector, FEED));
        pool.openPair("", p);
    }

    function test_liquidateRefusesPriceOlderThanHeartbeat() public {
        vm.warp(block.timestamp + 1 hours + 1);
        PairTypes.LiquidatePublic memory p;
        p.root = pool.EMPTY_ROOT();
        p.nullifier = bytes32(uint256(5));
        p.market = MARKET;
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.PriceStale.selector, FEED));
        pool.liquidate("", p);
    }

    function test_takerCloseRefusesPriceOlderThanHeartbeat() public {
        vm.warp(block.timestamp + 1 hours + 1);
        PairTypes.ClosePublic memory p = _deadClose();
        p.mode = 0;
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.OracleUnavailable.selector, MARKET));
        pool.closePair("", p);
    }
}

/// Stands in for open_pair's `assert_le(t4, max_close_spread)`: the proof carries the maker's close spread, and the last public
/// input is the cap the contract supplied.
contract CloseSpreadModel is IHonkVerifier {
    function verify(bytes calldata proof, bytes32[] calldata inputs) external pure returns (bool) {
        return abi.decode(proof, (uint256)) <= uint256(inputs[inputs.length - 1]);
    }
}

/// M36 contract rules (spec-pairs, spec-fees, spec-spot section 2, spec-contracts #24): churn bounds, the matured-exit freeze,
/// opens-only OI accounting, relay fee outputs, lockPair, public bond use, and each builder's layout against the regenerated
/// verifier. Every pairs verifier accepts, or captures the exact inputs on demand.
contract PrivatePairsM36Test is Test {
    uint256 internal constant MARKET = 1;
    uint256 internal constant MAX_PAIR = 100e18;
    uint256 internal constant SPREAD_CAP = 50;
    uint8 internal constant FREE = 1;
    uint8 internal constant LOCK = 2;
    uint8 internal constant PAIR = 3;

    PrivatePairs internal pool;
    MockERC20 internal usd;
    StubOracle internal oracle;
    CapturingVerifier internal lockV;
    CapturingVerifier internal openV;
    CapturingVerifier internal liqV;
    CapturingVerifier internal releaseV;
    CapturingVerifier internal epochV;
    CapturingVerifier internal closeV;
    CapturingVerifier internal exitV;
    CapturingVerifier internal updateV;
    uint256 internal nextNf = 1000;

    function setUp() public {
        vm.warp(1_800_000_000);
        usd = new MockERC20("Test USDG", "tUSDG", 6, type(uint256).max);
        oracle = new StubOracle();
        lockV = new CapturingVerifier();
        openV = new CapturingVerifier();
        liqV = new CapturingVerifier();
        releaseV = new CapturingVerifier();
        epochV = new CapturingVerifier();
        closeV = new CapturingVerifier();
        exitV = new CapturingVerifier();
        updateV = new CapturingVerifier();
        pool = _deploy(openV, SPREAD_CAP);
    }

    function _deploy(IHonkVerifier open, uint256 spreadCap) internal returns (PrivatePairs) {
        PairTypes.Verifiers memory v = PairTypes.Verifiers(lockV, open, liqV, releaseV, epochV, closeV, exitV, updateV);
        address[] memory assets = new address[](1);
        assets[0] = address(usd);
        PairTypes.MarketConfig[] memory ms = new PairTypes.MarketConfig[](1);
        ms[0] = PairTypes.MarketConfig(MARKET, address(usd), keccak256("F"), 0.1e18, 0.05e18, 100, 0.05e18, 10, 1e30, MAX_PAIR, spreadCap);
        return new PrivatePairs(
            PrivacyVerifiers.deploy("AppendVerifier"), PrivacyVerifiers.deploy("SpendVerifier"), assets, v, IPriceSource(address(oracle)), Grumpkin.point(1),
            [Grumpkin.point(2), Grumpkin.point(3)], PairTypes.FeeRecipient(9, Grumpkin.point(4)), ms, PairTypes.Modules(address(this), address(this), address(this))
        );
    }

    function _nf() internal returns (bytes32) {
        return bytes32(++nextNf);
    }

    function _fee(uint256 seed) internal pure returns (PairTypes.FeeOut memory f) {
        f.commitment = bytes32(seed);
        for (uint256 i; i < 7; i++) f.ct[i] = bytes32(seed + 1 + i);
    }

    function _assertFeeLast(bytes32[] memory inputs, uint256 seed) internal pure {
        uint256 n = inputs.length;
        assertEq(inputs[n - 8], bytes32(seed), "cm_relay right before ct_relay");
        for (uint256 i; i < 7; i++) assertEq(inputs[n - 7 + i], bytes32(seed + 1 + i), "ct_relay last");
    }

    function _assertMatchesVerifier(string memory name, bytes32[] memory inputs, uint256 expected) internal {
        assertEq(inputs.length, expected, string.concat(name, ": count in public-inputs.md"));
        assertTrue(Inputs.lengthAccepted(PrivacyVerifiers.deploy(name), inputs), string.concat(name, ": regenerated verifier refuses the count"));
    }

    struct Created {
        uint256 leaf;
        uint8 kind;
        bytes32 commitment;
    }

    function _created() internal view returns (Created[] memory out) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; i++) if (logs[i].topics[0] == PrivatePairs.RecordCreated.selector) n++;
        out = new Created[](n);
        n = 0;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] != PrivatePairs.RecordCreated.selector) continue;
            (bytes32 cm,) = abi.decode(logs[i].data, (bytes32, bytes32[]));
            out[n++] = Created(uint256(logs[i].topics[1]), uint8(uint256(logs[i].topics[2])), cm);
        }
    }

    function _lockP(uint256 seed) internal returns (PairTypes.LockPublic memory p) {
        p.root = pool.EMPTY_ROOT();
        p.nullifiers[0] = _nf();
        p.nullifiers[1] = _nf();
        p.changeCommitment = bytes32(seed + 100);
        p.lockCommitment = bytes32(seed + 200);
        p.asOf = block.timestamp;
        p.relayFee = _fee(seed + 300);
    }

    function _updateP(bytes32 nf, bytes32 carried) internal returns (PairTypes.UpdatePublic memory p) {
        p.root = pool.EMPTY_ROOT();
        p.market = MARKET;
        p.nullifiers[0] = nf;
        p.nullifiers[1] = _nf();
        p.pairCommitment = bytes32(uint256(nf) + 1);
        p.deltaCommitment = bytes32(uint256(nf) + 2);
        p.carriedNullifier = carried;
        p.asOf = block.timestamp;
        p.relayFee = _fee(uint256(nf) + 10);
    }

    function _openP() internal returns (PairTypes.OpenPublic memory p) {
        p.root = pool.EMPTY_ROOT();
        p.market = MARKET;
        p.asOf = block.timestamp;
        p.nullifiers[0] = _nf();
        p.nullifiers[1] = _nf();
        p.deltaCommitment = bytes32(uint256(p.nullifiers[0]) + 7);
    }

    function _closeP(bytes32 nf, uint256 mode) internal pure returns (PairTypes.ClosePublic memory p) {
        p.nullifier = nf;
        p.market = MARKET;
        p.mode = mode;
        p.deltaCommitment = bytes32(uint256(nf) + 3);
        p.relayFee = _fee(uint256(nf) + 20);
    }

    function _captureLock(PairTypes.LockPublic memory p) internal returns (bytes32[] memory inputs) {
        lockV.capture(true);
        try pool.lock("", p) {
            revert("not captured");
        } catch (bytes memory r) {
            inputs = Inputs.decode(r);
        }
        lockV.capture(false);
    }

    function _captureUpdate(PairTypes.UpdatePublic memory p) internal returns (bytes32[] memory inputs) {
        updateV.capture(true);
        try pool.updatePair("", p) {
            revert("not captured");
        } catch (bytes memory r) {
            inputs = Inputs.decode(r);
        }
        updateV.capture(false);
    }

    function _captureOpen(PairTypes.OpenPublic memory p) internal returns (bytes32[] memory inputs) {
        openV.capture(true);
        try pool.openPair("", p) {
            revert("not captured");
        } catch (bytes memory r) {
            inputs = Inputs.decode(r);
        }
        openV.capture(false);
    }

    function _captureEpoch(PairTypes.FundingPublic memory p) internal returns (bytes32[] memory inputs) {
        epochV.capture(true);
        try pool.advanceFunding("", p) {
            revert("not captured");
        } catch (bytes memory r) {
            inputs = Inputs.decode(r);
        }
        epochV.capture(false);
    }

    function _epoch(uint256 bondUsedNext) internal returns (PairTypes.FundingPublic memory p) {
        vm.warp(block.timestamp + 30);
        p.market = MARKET;
        p.asOf = block.timestamp;
        p.newHead = bytes32(uint256(77));
        p.bondUsedNext = bondUsedNext;
    }

    // ---- lock (#14, fee output) ----

    function test_lockInputsEndWithAsOfLifetimesAndRelayFee() public {
        PairTypes.LockPublic memory p = _lockP(1);
        p.asOf = block.timestamp - 3 hours;
        bytes32[] memory inputs = _captureLock(p);
        uint256 n = inputs.length;
        assertEq(inputs[n - 11], bytes32(p.asOf));
        assertEq(inputs[n - 10], bytes32(uint256(7 days)), "intent cap");
        assertEq(inputs[n - 9], bytes32(uint256(30 days)), "maker cap");
        _assertFeeLast(inputs, 301);
        _assertMatchesVerifier("LockVerifier", inputs, 90);
    }

    function test_lockRejectsFutureAsOf() public {
        PairTypes.LockPublic memory p = _lockP(1);
        p.asOf = block.timestamp + 1;
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.StaleAsOf.selector, p.asOf, block.timestamp));
        pool.lock("", p);
    }

    /// An older asOf only shortens the expiry the circuit allows, so a lock proved a while ago still lands.
    function test_lockAcceptsOldAsOf() public {
        PairTypes.LockPublic memory p = _lockP(1);
        p.asOf = block.timestamp - 1 days;
        pool.lock("", p);
        assertTrue(pool.nullifierSpent(p.nullifiers[0]));
    }

    function test_lockCreatesChangeThenRelayFeeThenLock() public {
        PairTypes.LockPublic memory p = _lockP(1);
        vm.recordLogs();
        pool.lock("", p);
        Created[] memory c = _created();
        assertEq(c.length, 3);
        assertEq(c[0].commitment, p.changeCommitment);
        assertEq(c[1].commitment, p.relayFee.commitment);
        assertEq(c[1].kind, FREE);
        assertEq(c[2].commitment, p.lockCommitment);
        assertEq(c[2].kind, LOCK);
    }

    // ---- lockPair (spec-spot section 2) ----

    function test_lockPairWritesLocksAtAdjacentLeavesAfterEveryFreeOutput() public {
        pool.lock("", _lockP(10));
        PairTypes.LockPublic memory p0 = _lockP(20);
        PairTypes.LockPublic memory p1 = _lockP(30);
        vm.recordLogs();
        pool.lockPair("", p0, "", p1);
        Created[] memory c = _created();
        assertEq(c.length, 6);
        bytes32[6] memory order =
            [p0.changeCommitment, p1.changeCommitment, p0.relayFee.commitment, p1.relayFee.commitment, p0.lockCommitment, p1.lockCommitment];
        for (uint256 i; i < 6; i++) {
            assertEq(c[i].commitment, order[i]);
            assertEq(c[i].kind, i < 4 ? FREE : LOCK);
            assertEq(c[i].leaf, 3 + i, "consecutive leaves after the earlier lock");
        }
        assertEq(c[5].leaf, c[4].leaf + 1, "lp_add needs lock1 at lock0 + 1");
        for (uint256 i; i < 2; i++) {
            assertTrue(pool.nullifierSpent(p0.nullifiers[i]));
            assertTrue(pool.nullifierSpent(p1.nullifiers[i]));
        }
    }

    function test_lockPairVerifiesBothHalvesAgainstTheLockLayout() public {
        PairTypes.LockPublic memory p0 = _lockP(20);
        PairTypes.LockPublic memory p1 = _lockP(30);
        lockV.capture(true);
        try pool.lockPair("", p0, "", p1) {
            revert("not captured");
        } catch (bytes memory r) {
            _assertFeeLast(Inputs.decode(r), 320);
        }
    }

    function test_lockPairRejectsNullifierSharedAcrossHalves() public {
        PairTypes.LockPublic memory p0 = _lockP(20);
        PairTypes.LockPublic memory p1 = _lockP(30);
        p1.nullifiers[1] = p0.nullifiers[0];
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NullifierSpent.selector, p0.nullifiers[0]));
        pool.lockPair("", p0, "", p1);
    }

    function test_lockPairRevertsWholeWhenSecondHalfFails() public {
        PairTypes.LockPublic memory p0 = _lockP(20);
        PairTypes.LockPublic memory p1 = _lockP(30);
        p1.asOf = block.timestamp + 1;
        uint256 queued = pool.queueLength();
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.StaleAsOf.selector, p1.asOf, block.timestamp));
        pool.lockPair("", p0, "", p1);
        assertFalse(pool.nullifierSpent(p0.nullifiers[0]));
        assertEq(pool.queueLength(), queued);
    }

    // ---- updatePair (#4, #5, #17, fee output) ----

    function test_updateInputsEndWithMmrAsOfGapAndRelayFee() public {
        PairTypes.UpdatePublic memory p = _updateP(_nf(), 0);
        bytes32[] memory inputs = _captureUpdate(p);
        uint256 n = inputs.length;
        assertEq(inputs[n - 11], bytes32(uint256(0.05e18)), "mmr_wad from the market");
        assertEq(inputs[n - 10], bytes32(p.asOf));
        assertEq(inputs[n - 9], bytes32(uint256(600)), "min_gap");
        assertEq(pool.MIN_UPDATE_GAP(), 600);
        _assertFeeLast(inputs, uint256(p.nullifiers[0]) + 10);
        _assertMatchesVerifier("PairUpdateVerifier", inputs, 140);
    }

    function test_updateRejectsFutureAsOf() public {
        PairTypes.UpdatePublic memory p = _updateP(_nf(), 0);
        p.asOf = block.timestamp + 1;
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.StaleAsOf.selector, p.asOf, block.timestamp));
        pool.updatePair("", p);
    }

    function test_updateRejectsAsOfOlderThanSkew() public {
        PairTypes.UpdatePublic memory p = _updateP(_nf(), 0);
        p.asOf = block.timestamp - 5 minutes - 1;
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.StaleAsOf.selector, p.asOf, block.timestamp));
        pool.updatePair("", p);
        p.asOf = block.timestamp - 5 minutes;
        pool.updatePair("", p);
    }

    /// Browser proving takes minutes, so an as_of stamped 4 minutes before inclusion must still land.
    function test_updateAcceptsAsOfFromSlowBrowserProof() public {
        PairTypes.UpdatePublic memory p = _updateP(_nf(), 0);
        p.asOf = block.timestamp - 4 minutes;
        pool.updatePair("", p);
        assertTrue(pool.nullifierSpent(p.nullifiers[0]));
    }

    function test_updateCreatesPairOutMarketFeeThenRelayFee() public {
        PairTypes.UpdatePublic memory p = _updateP(_nf(), 0);
        p.outCommitment = bytes32(uint256(501));
        p.feeCommitment = bytes32(uint256(502));
        vm.recordLogs();
        pool.updatePair("", p);
        Created[] memory c = _created();
        assertEq(c.length, 4);
        assertEq(c[0].kind, PAIR);
        assertEq(c[1].commitment, p.outCommitment);
        assertEq(c[2].commitment, p.feeCommitment);
        assertEq(c[3].commitment, p.relayFee.commitment);
        assertEq(c[3].kind, FREE);
    }

    function _requestExit(bytes32 nf) internal {
        pool.requestExit{value: pool.EXIT_BOND()}("", pool.EMPTY_ROOT(), nf);
    }

    function test_updateBeforeMaturityCarriesTheRequest() public {
        bytes32 a = _nf();
        bytes32 b = _nf();
        _requestExit(a);
        (, uint64 matureAt) = pool.exitRequests(a);
        vm.warp(matureAt - 1);
        pool.updatePair("", _updateP(a, b));
        (address requester, uint64 carried) = pool.exitRequests(b);
        assertEq(requester, address(this));
        assertEq(carried, matureAt, "deadline never moves");
    }

    function test_updateRefusedOnceExitMatured() public {
        bytes32 a = _nf();
        _requestExit(a);
        (, uint64 matureAt) = pool.exitRequests(a);
        vm.warp(matureAt);
        PairTypes.UpdatePublic memory p = _updateP(a, _nf());
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.ExitMatured.selector, a));
        pool.updatePair("", p);
    }

    /// The audit's churn scenario: the counterparty replaces the pair at every cooldown (20 rounds here). Each update carries the
    /// request, and once it matures the lineage is frozen, so the forced close lands.
    function test_maturedExitCompletesWhileCounterpartyTriesToChurn() public {
        bytes32 current = _nf();
        _requestExit(current);
        (, uint64 matureAt) = pool.exitRequests(current);
        for (uint256 round; round < 20; round++) {
            vm.warp(block.timestamp + 10 minutes);
            bytes32 next = _nf();
            pool.updatePair("", _updateP(current, next));
            current = next;
        }
        vm.warp(matureAt);
        PairTypes.UpdatePublic memory churn = _updateP(current, _nf());
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.ExitMatured.selector, current));
        pool.updatePair("", churn);
        PairTypes.ClosePublic memory c = _closeP(current, 1);
        c.root = pool.EMPTY_ROOT();
        pool.closePair("", c);
        assertTrue(pool.nullifierSpent(current));
        assertEq(pool.bondBalance(address(this)), pool.EXIT_BOND());
    }

    // ---- openPair (#5 stamp bound, #7, #9) ----

    function test_openRejectsAsOfTooFarAhead() public {
        PairTypes.OpenPublic memory p = _openP();
        p.asOf = block.timestamp + 10 minutes + 1;
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.StaleAsOf.selector, p.asOf, block.timestamp));
        pool.openPair("", p);
        p.asOf = block.timestamp + 10 minutes;
        pool.openPair("", p);
    }

    function test_openInputsEndWithMaxCloseSpread() public {
        bytes32[] memory inputs = _captureOpen(_openP());
        assertEq(inputs[inputs.length - 1], bytes32(SPREAD_CAP), "max_close_spread from the market");
        assertEq(inputs[inputs.length - 2], bytes32(MAX_PAIR), "max_pair_size right before it");
        _assertMatchesVerifier("OpenPairVerifier", inputs, 134);
    }

    function test_closeSpreadAboveCapRefusedByContractInput() public {
        PrivatePairs capped = _deploy(new CloseSpreadModel(), SPREAD_CAP);
        pool = capped;
        PairTypes.OpenPublic memory p = _openP();
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        capped.openPair(abi.encode(SPREAD_CAP + 1), p);
        capped.openPair(abi.encode(SPREAD_CAP), p);
        assertEq(capped.pendingOpens(MARKET), 1);
    }

    function test_constructorRejectsCloseSpreadCapAboveCeiling() public {
        assertEq(pool.MAX_CLOSE_SPREAD_BPS(), 1_000);
        vm.expectRevert(abi.encodeWithSelector(PrivatePairs.BadMarketConfig.selector, MARKET));
        _deploy(openV, 1_001);
        assertEq(_deploy(openV, 1_000).market(MARKET).maxCloseSpreadBps, 1_000);
    }

    /// Audit #7 (Audita2): no-op updates queue deltas but never count toward the open-interest worst case.
    function test_noOpUpdatesDoNotRaisePendingOpens() public {
        pool.openPair("", _openP());
        for (uint256 i; i < 20; i++) pool.updatePair("", _updateP(_nf(), 0));
        assertEq(pool.oiDeltaCount(MARKET), 21);
        assertEq(pool.pendingOpens(MARKET), 1);
        bytes32[] memory inputs = _captureOpen(_openP());
        assertEq(inputs[inputs.length - 4], bytes32(MAX_PAIR), "oi_pending counts the one open, not 21 deltas");
    }

    function test_pendingOpensFallAsOpensFold() public {
        pool.openPair("", _openP());
        for (uint256 i; i < 20; i++) pool.updatePair("", _updateP(_nf(), 0));
        pool.advanceFunding("", _epoch(0));
        assertEq(pool.funding(MARKET).consumed, 8);
        assertEq(pool.opensFolded(MARKET), 1);
        assertEq(pool.pendingOpens(MARKET), 0);
        bytes32[] memory inputs = _captureOpen(_openP());
        assertEq(inputs[inputs.length - 4], bytes32(0), "a market with 13 unfolded updates still opens at full size");
    }

    function test_pendingOpensIgnoresClaimDeltas() public {
        PairTypes.LiquidatePublic memory l;
        l.root = pool.EMPTY_ROOT();
        l.nullifier = _nf();
        l.market = MARKET;
        l.deltaCommitment = bytes32(uint256(9));
        pool.liquidate("", l);
        PairTypes.ClosePublic memory c = _closeP(_nf(), 0);
        c.root = pool.EMPTY_ROOT();
        pool.closePair("", c);
        assertEq(pool.oiDeltaCount(MARKET), 2);
        assertEq(pool.pendingOpens(MARKET), 0);
        pool.advanceFunding("", _epoch(0));
        assertEq(pool.opensFolded(MARKET), 0);
    }

    // ---- close, release (fee output) ----

    function test_closeInputsEndWithRelayFeeAndFeeIsLastRecord() public {
        bytes32 nf = _nf();
        PairTypes.ClosePublic memory c = _closeP(nf, 0);
        c.root = pool.EMPTY_ROOT();
        closeV.capture(true);
        try pool.closePair("", c) {
            revert("not captured");
        } catch (bytes memory r) {
            bytes32[] memory inputs = Inputs.decode(r);
            _assertFeeLast(inputs, uint256(nf) + 20);
            _assertMatchesVerifier("ClosePairVerifier", inputs, 46);
        }
        closeV.capture(false);
        vm.recordLogs();
        pool.closePair("", c);
        Created[] memory created = _created();
        assertEq(created.length, 4);
        assertEq(created[3].commitment, c.relayFee.commitment);
        assertEq(created[3].kind, FREE);
    }

    function test_releaseInputsEndWithRelayFeeAndFeeIsLastRecord() public {
        PairTypes.ReleasePublic memory p;
        p.root = pool.EMPTY_ROOT();
        p.nullifier = _nf();
        p.commitment = bytes32(uint256(61));
        p.asOf = block.timestamp;
        p.relayFee = _fee(70);
        releaseV.capture(true);
        try pool.release("", p) {
            revert("not captured");
        } catch (bytes memory r) {
            bytes32[] memory inputs = Inputs.decode(r);
            _assertFeeLast(inputs, 70);
            _assertMatchesVerifier("ReleaseVerifier", inputs, 20);
        }
        releaseV.capture(false);
        vm.recordLogs();
        pool.release("", p);
        Created[] memory created = _created();
        assertEq(created.length, 2);
        assertEq(created[0].commitment, p.commitment);
        assertEq(created[1].commitment, p.relayFee.commitment);
    }

    // ---- funding (#24 option B) ----

    function test_fundingPassesStoredBondUsedAndStoresNext() public {
        bytes32[] memory inputs = _captureEpoch(_epoch(5e6));
        uint256 n = inputs.length;
        assertEq(inputs[n - 2], bytes32(0), "bond_used_prev is the stored value");
        assertEq(inputs[n - 1], bytes32(uint256(5e6)));
        _assertMatchesVerifier("FundingEpochVerifier", inputs, 52);

        pool.advanceFunding("", _epoch(5e6));
        assertEq(pool.funding(MARKET).bondUsed, 5e6);
        inputs = _captureEpoch(_epoch(6e6));
        assertEq(inputs[inputs.length - 2], bytes32(uint256(5e6)), "the next epoch must start from what was stored");
    }

    /// Unchanged circuits keep their layout against the regenerated verifiers.
    function test_unchangedBuildersMatchRegeneratedVerifiers() public {
        PairTypes.LiquidatePublic memory l;
        l.root = pool.EMPTY_ROOT();
        l.nullifier = _nf();
        l.market = MARKET;
        liqV.capture(true);
        try pool.liquidate("", l) {
            revert("not captured");
        } catch (bytes memory r) {
            _assertMatchesVerifier("LiquidateVerifier", Inputs.decode(r), 79);
        }
        exitV.capture(true);
        uint256 bond = pool.EXIT_BOND();
        bytes32 root = pool.EMPTY_ROOT();
        try pool.requestExit{value: bond}("", root, bytes32(uint256(5))) {
            revert("not captured");
        } catch (bytes memory r) {
            _assertMatchesVerifier("ExitRequestVerifier", Inputs.decode(r), 3);
        }
    }
}
