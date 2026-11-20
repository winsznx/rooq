// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {MockERC20} from "../../src/tokens/MockERC20.sol";
import {IHonkVerifier} from "../../src/privacy/ShieldedPool.sol";
import {IPriceSource, PrivatePairs} from "../../src/privacy/PrivatePairs.sol";
import {PairTypes} from "../../src/privacy/PairTypes.sol";
import {PrivateSpot} from "../../src/privacy/PrivateSpot.sol";
import {PrivacyVerifiers} from "../utils/PrivacyVerifiers.sol";
import {Grumpkin} from "../utils/Grumpkin.sol";
import {CapturingVerifier, Inputs} from "../utils/MockVerifiers.sol";

/// Protocol share of pool fees and its sweep (spec-spot section 4). Spot verifiers accept, or capture the exact inputs on demand.
contract PrivateSpotTest is Test {
    uint256 internal constant FEE_AUTH = 9;
    PrivatePairs internal custody;
    PrivateSpot internal spot;
    address internal governor = makeAddr("timelock");
    address[] internal tokens;
    CapturingVerifier internal swapV;
    CapturingVerifier internal sweepV;

    function setUp() public {
        vm.warp(1_800_000_000);
        for (uint256 i; i < 3; i++) tokens.push(address(new MockERC20("T", "T", 18, 1)));
        swapV = new CapturingVerifier();
        sweepV = new CapturingVerifier();
        PairTypes.Verifiers memory pv = PrivacyVerifiers.pairs();
        IHonkVerifier app = PrivacyVerifiers.deploy("AppendVerifier");
        IHonkVerifier spend = PrivacyVerifiers.deploy("SpendVerifier");
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        custody = new PrivatePairs(
            app, spend, tokens, pv, IPriceSource(address(0)), Grumpkin.point(1), [Grumpkin.point(2), Grumpkin.point(3)],
            PairTypes.FeeRecipient(FEE_AUTH, Grumpkin.point(4)), new PairTypes.MarketConfig[](0), PairTypes.Modules(predicted, address(this), address(this))
        );
        spot = new PrivateSpot(custody, _verifiers(), _pools(0), governor);
        assertEq(address(spot), predicted);
    }

    function _verifiers() internal view returns (PrivateSpot.Verifiers memory) {
        return PrivateSpot.Verifiers(swapV, swapV, swapV, swapV, sweepV);
    }

    function _pools(uint256 share) internal view returns (PrivateSpot.PoolConfig[] memory pools) {
        pools = new PrivateSpot.PoolConfig[](2);
        pools[0] = PrivateSpot.PoolConfig(1, tokens[0], tokens[1], 30, share);
        pools[1] = PrivateSpot.PoolConfig(2, tokens[1], tokens[2], 30, 0);
    }

    function _swap(uint256 secondPool) internal view returns (PrivateSpot.SwapPublic memory p) {
        p.root = custody.EMPTY_ROOT();
        p.nullifier = bytes32(uint256(1));
        p.asOf = block.timestamp;
        p.pool[0] = 1;
        p.pool[1] = secondPool;
    }

    function _captureSwap(PrivateSpot.SwapPublic memory p) internal returns (bytes32[] memory inputs) {
        swapV.capture(true);
        try spot.swap("", p) {
            revert("not captured");
        } catch (bytes memory r) {
            inputs = Inputs.decode(r);
        }
        swapV.capture(false);
    }

    function test_setProtocolShare_onlyGovernor() public {
        vm.expectRevert(PrivateSpot.NotGovernor.selector);
        spot.setProtocolShare(1, 100);
        vm.expectEmit(address(spot));
        emit PrivateSpot.ProtocolShareSet(1, 100);
        vm.prank(governor);
        spot.setProtocolShare(1, 100);
        assertEq(spot.pool(1).protocolBps, 100);
        assertEq(spot.pool(2).protocolBps, 0, "per pool");
    }

    function test_setProtocolShare_rejectsAboveCapAndUnknownPool() public {
        assertEq(spot.MAX_PROTOCOL_SHARE_BPS(), 2_500);
        vm.startPrank(governor);
        vm.expectRevert(abi.encodeWithSelector(PrivateSpot.ShareTooHigh.selector, 2_501));
        spot.setProtocolShare(1, 2_501);
        spot.setProtocolShare(1, 2_500);
        vm.expectRevert(abi.encodeWithSelector(PrivateSpot.UnknownPool.selector, 9));
        spot.setProtocolShare(9, 1);
        vm.stopPrank();
    }

    function test_constructor_rejectsShareAboveCap() public {
        PrivateSpot.Verifiers memory v = _verifiers();
        PrivateSpot.PoolConfig[] memory pools = _pools(2_501);
        vm.expectRevert(abi.encodeWithSelector(PrivateSpot.BadPool.selector, 1));
        new PrivateSpot(custody, v, pools, governor);
    }

    function test_swapInputs_carryProtocolShareAfterFees() public {
        vm.prank(governor);
        spot.setProtocolShare(1, 100);
        bytes32[] memory inputs = _captureSwap(_swap(0));
        assertEq(inputs[18], bytes32(uint256(30)), "fee_bps[0]");
        assertEq(inputs[19], bytes32(0), "fee_bps[1] of an unused hop");
        assertEq(inputs[20], bytes32(uint256(100)), "protocol_bps[0]");
        assertEq(inputs[21], bytes32(0), "an unused second hop passes 0");
        assertEq(inputs.length, 86);
        assertTrue(Inputs.lengthAccepted(PrivacyVerifiers.deploy("SwapVerifier"), inputs));

        vm.prank(governor);
        spot.setProtocolShare(2, 200);
        inputs = _captureSwap(_swap(2));
        assertEq(inputs[21], bytes32(uint256(200)), "protocol_bps[1] of the second hop");
    }

    function _sweepP() internal pure returns (PrivateSpot.ProtocolSweepPublic memory p) {
        p.pool = 1;
        p.newHead = bytes32(uint256(44));
        p.outCommitments[0] = bytes32(uint256(51));
        p.outCommitments[1] = bytes32(uint256(52));
    }

    function test_sweepProtocolFees_paysFeeAddress() public {
        PrivateSpot.ProtocolSweepPublic memory p = _sweepP();
        sweepV.capture(true);
        try spot.sweepProtocolFees("", p) {
            revert("not captured");
        } catch (bytes memory r) {
            bytes32[] memory inputs = Inputs.decode(r);
            assertEq(inputs.length, 58);
            assertEq(inputs[45], bytes32(custody.deploymentId()));
            assertEq(inputs[46], bytes32(uint256(1)), "pool");
            assertEq(inputs[47], bytes32(uint256(uint160(tokens[0]))));
            assertEq(inputs[48], bytes32(uint256(uint160(tokens[1]))));
            assertEq(inputs[49], bytes32(FEE_AUTH), "fee_auth from custody");
            assertEq(inputs[50], bytes32(Grumpkin.point(4).x), "fee key from custody");
            assertEq(inputs[51], bytes32(Grumpkin.point(4).y));
            assertEq(inputs[52], bytes32(Grumpkin.point(1).x), "pool keys follow");
            assertTrue(Inputs.lengthAccepted(PrivacyVerifiers.deploy("SweepProtocolVerifier"), inputs));
        }
        sweepV.capture(false);

        vm.recordLogs();
        spot.sweepProtocolFees("", p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 created;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] != PrivatePairs.RecordCreated.selector) continue;
            (bytes32 cm,) = abi.decode(logs[i].data, (bytes32, bytes32[]));
            assertEq(uint8(uint256(logs[i].topics[2])), 1, "FREE");
            assertEq(cm, p.outCommitments[created++]);
        }
        assertEq(created, 2);
        assertEq(spot.pool(1).head, p.newHead);
    }

    /// POOL_CT_LEN went from 7 to 9; these builders only changed through it.
    function test_lpBuildersMatchRegeneratedVerifiers() public {
        swapV.capture(true);
        PrivateSpot.LpAddPublic memory a;
        a.root = custody.EMPTY_ROOT();
        a.nullifiers = [bytes32(uint256(1)), bytes32(uint256(2))];
        a.asOf = block.timestamp;
        a.pool = 1;
        try spot.addLiquidity("", a) {
            revert("not captured");
        } catch (bytes memory r) {
            bytes32[] memory inputs = Inputs.decode(r);
            assertEq(inputs.length, 108);
            assertTrue(Inputs.lengthAccepted(PrivacyVerifiers.deploy("LpAddVerifier"), inputs));
        }
        PrivateSpot.LpRemovePublic memory m;
        m.root = custody.EMPTY_ROOT();
        m.nullifier = bytes32(uint256(3));
        m.asOf = block.timestamp;
        m.pool = 1;
        try spot.removeLiquidity("", m) {
            revert("not captured");
        } catch (bytes memory r) {
            bytes32[] memory inputs = Inputs.decode(r);
            assertEq(inputs.length, 58);
            assertTrue(Inputs.lengthAccepted(PrivacyVerifiers.deploy("LpRemoveVerifier"), inputs));
        }
        PrivateSpot.LpSetPublic memory s;
        s.root = custody.EMPTY_ROOT();
        s.nullifier = bytes32(uint256(4));
        s.asOf = block.timestamp;
        try spot.setLiquidityRequest("", s) {
            revert("not captured");
        } catch (bytes memory r) {
            bytes32[] memory inputs = Inputs.decode(r);
            assertEq(inputs.length, 60);
            assertTrue(Inputs.lengthAccepted(PrivacyVerifiers.deploy("LpSetVerifier"), inputs));
        }
    }

    function test_sweepProtocolFees_unknownPool() public {
        PrivateSpot.ProtocolSweepPublic memory p = _sweepP();
        p.pool = 9;
        vm.expectRevert(abi.encodeWithSelector(PrivateSpot.UnknownPool.selector, 9));
        spot.sweepProtocolFees("", p);
    }
}
