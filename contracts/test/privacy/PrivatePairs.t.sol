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
import {IHonkVerifier, ShieldedPool} from "../../src/privacy/ShieldedPool.sol";
import {IPriceSource, PrivatePairs} from "../../src/privacy/PrivatePairs.sol";
import {PairTypes} from "../../src/privacy/PairTypes.sol";

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
        appendV = IHonkVerifier(address(new AppendVerifier()));
        spendV = IHonkVerifier(address(new SpendVerifier()));
        v = PairTypes.Verifiers(
            IHonkVerifier(address(new LockVerifier())),
            IHonkVerifier(address(new OpenPairVerifier())),
            IHonkVerifier(address(new LiquidateVerifier())),
            IHonkVerifier(address(new ReleaseVerifier())),
            IHonkVerifier(address(new FundingEpochVerifier())),
            IHonkVerifier(address(new ClosePairVerifier())),
            IHonkVerifier(address(new ExitRequestVerifier())),
            IHonkVerifier(address(new PairUpdateVerifier()))
        );
        pool = _deploy(_config(MARKET, address(usd), 0.1e18, 0.05e18, 100), _pt(1), _pt(2), _pt(3));
    }

    function _pt(uint256 x) internal pure returns (PairTypes.Point memory) {
        return PairTypes.Point(x, x + 1);
    }

    function _config(uint256 id, address asset, uint256 imr, uint256 mmr, uint256 penalty)
        internal
        pure
        returns (PairTypes.MarketConfig[] memory ms)
    {
        ms = new PairTypes.MarketConfig[](1);
        ms[0] = PairTypes.MarketConfig(id, asset, keccak256("F"), imr, mmr, penalty, 0.05e18, 10, 1e30, 100e18);
    }

    function _deploy(
        PairTypes.MarketConfig[] memory ms,
        PairTypes.Point memory coordinator,
        PairTypes.Point memory a,
        PairTypes.Point memory b
    ) internal returns (PrivatePairs) {
        return new PrivatePairs(appendV, spendV, assets, v, IPriceSource(address(oracle)), coordinator, [a, b], PairTypes.FeeRecipient(9, PairTypes.Point(7, 8)), ms, PairTypes.Modules(address(this), address(this)));
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
