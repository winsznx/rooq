// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MockERC20} from "../../src/tokens/MockERC20.sol";
import {AppendVerifier} from "../../src/privacy/verifiers/AppendVerifier.sol";
import {SpendVerifier} from "../../src/privacy/verifiers/SpendVerifier.sol";
import {ShieldedPool, IHonkVerifier} from "../../src/privacy/ShieldedPool.sol";
import {AcceptAllVerifier, InputBoundVerifier} from "../utils/MockVerifiers.sol";

/// Takes 1% of every transfer, so the pool receives less than the caller claims.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {
        _mint(msg.sender, 1e30);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xdead), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// Pool checks that hold before any proof is verified. Proof-dependent paths (append, spend, replay, tampering,
/// deployment binding) run with real proofs in e2e/private/shielded-flow.ts.
contract ShieldedPoolTest is Test {
    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    ShieldedPool internal pool;
    MockERC20 internal usd;
    FeeOnTransferToken internal fot;
    address internal alice = makeAddr("alice");

    function setUp() public {
        usd = new MockERC20("Test USDG", "tUSDG", 6, type(uint256).max);
        fot = new FeeOnTransferToken();
        address[] memory assets = new address[](2);
        assets[0] = address(usd);
        assets[1] = address(fot);
        pool = new ShieldedPool(IHonkVerifier(address(new AppendVerifier())), IHonkVerifier(address(new SpendVerifier())), assets);
        usd.mintTo(alice, 1_000e6);
        vm.prank(alice);
        usd.approve(address(pool), type(uint256).max);
    }

    function test_deploymentIdBindsChainAndAddress() public view {
        assertEq(pool.deploymentId(), (block.chainid << 160) | uint256(uint160(address(pool))));
        assertLt(pool.deploymentId(), FIELD);
    }

    function test_startsAtEmptyRoot() public view {
        assertEq(pool.root(), pool.EMPTY_ROOT());
        assertTrue(pool.isKnownRoot(pool.EMPTY_ROOT()));
    }

    function test_shieldQueuesExactAmount() public {
        vm.prank(alice);
        uint256 leaf = pool.shield(address(usd), 600e6, bytes32(uint256(42)));
        ShieldedPool.Entry memory e = pool.queueEntry(leaf);
        assertEq(abi.encode(e.kind, e.a, e.b, e.c), abi.encode(uint8(1), bytes32(uint256(42)), bytes32(uint256(uint160(address(usd)))), bytes32(uint256(600e6))));
        assertEq(usd.balanceOf(address(pool)), 600e6);
    }

    function test_shieldRejectsUnsupportedAsset() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.UnsupportedAsset.selector, address(other)));
        vm.prank(alice);
        pool.shield(address(other), 1, bytes32(uint256(1)));
    }

    function test_shieldRejectsZeroAndOversizedAmounts() public {
        vm.startPrank(alice);
        vm.expectRevert(ShieldedPool.BadAmount.selector);
        pool.shield(address(usd), 0, bytes32(uint256(1)));
        uint256 tooBig = pool.MAX_AMOUNT() + 1;
        vm.expectRevert(ShieldedPool.BadAmount.selector);
        pool.shield(address(usd), tooBig, bytes32(uint256(1)));
        vm.stopPrank();
    }

    function test_shieldRejectsNonFieldInner() public {
        vm.expectRevert(ShieldedPool.NotAFieldElement.selector);
        vm.prank(alice);
        pool.shield(address(usd), 1, bytes32(FIELD));
    }

    function test_shieldRejectsFeeOnTransferToken() public {
        fot.approve(address(pool), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.TransferAmountMismatch.selector, 100e18, 99e18));
        pool.shield(address(fot), 100e18, bytes32(uint256(1)));
    }

    function test_donationMintsNoClaim() public {
        usd.mintTo(address(pool), 5e6);
        assertEq(pool.queueLength(), 0, "a plain transfer creates no queue entry");
    }

    function test_processQueueWithNothingQueuedReverts() public {
        vm.expectRevert(ShieldedPool.NothingQueued.selector);
        pool.processQueue("", bytes32(0), 1);
    }

    function test_processQueueRejectsGarbageProof() public {
        vm.prank(alice);
        pool.shield(address(usd), 1e6, bytes32(uint256(7)));
        vm.expectRevert();
        pool.processQueue(new bytes(9000), bytes32(uint256(1)), 1);
        assertEq(pool.processed(), 0);
        assertEq(pool.root(), pool.EMPTY_ROOT());
    }

    function test_spendRejectsUnknownRoot() public {
        ShieldedPool.SpendPublic memory p;
        p.root = bytes32(uint256(123));
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.UnknownRoot.selector, p.root));
        pool.spend("", p);
    }

    function test_spendRejectsGarbageProofAndKeepsNullifiersUnspent() public {
        ShieldedPool.SpendPublic memory p;
        p.root = pool.EMPTY_ROOT();
        p.nullifiers[0] = bytes32(uint256(1));
        p.nullifiers[1] = bytes32(uint256(2));
        vm.expectRevert();
        pool.spend(new bytes(9000), p);
        assertFalse(pool.nullifierSpent(bytes32(uint256(1))));
    }

    function test_unrecordedRootIsUnknown() public view {
        assertFalse(pool.isKnownRoot(bytes32(uint256(99))));
    }

    function test_shieldRejectsReusedInner() public {
        vm.startPrank(alice);
        pool.shield(address(usd), 1e6, bytes32(uint256(42)));
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.InnerReused.selector, bytes32(uint256(42))));
        pool.shield(address(usd), 1e6, bytes32(uint256(42)));
        vm.stopPrank();
        assertEq(pool.queueLength(), 1);
    }

    /// Reuse links two deposits publicly whatever they carry, so asset and amount do not matter.
    function test_shieldRejectsReusedInnerAcrossAssetsAndAmounts() public {
        vm.prank(alice);
        pool.shield(address(usd), 1e6, bytes32(uint256(42)));
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.InnerReused.selector, bytes32(uint256(42))));
        vm.prank(alice);
        pool.shield(address(usd), 2e6, bytes32(uint256(42)));
        fot.approve(address(pool), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.InnerReused.selector, bytes32(uint256(42))));
        pool.shield(address(fot), 1e18, bytes32(uint256(42)));
    }

    function test_innerNotMarkedWhenShieldReverts() public {
        fot.approve(address(pool), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.TransferAmountMismatch.selector, 100e18, 99e18));
        pool.shield(address(fot), 100e18, bytes32(uint256(5)));
        assertFalse(pool.usedInner(bytes32(uint256(5))));
        vm.prank(alice);
        pool.shield(address(usd), 1e6, bytes32(uint256(5)));
        assertTrue(pool.usedInner(bytes32(uint256(5))));
    }

    /// Indexers and wallets read these; any change to a leaf event or the root sequence breaks every scanner.
    function test_leafEventsAndRootSequenceArePinned() public view {
        assertEq(ShieldedPool.Shielded.selector, keccak256("Shielded(uint256,address,uint256,bytes32,address)"));
        assertEq(ShieldedPool.NotesCreated.selector, keccak256("NotesCreated(uint256,bytes32[3],bytes32[7][3])"));
        assertEq(ShieldedPool.RootUpdated.selector, keccak256("RootUpdated(bytes32,uint256,uint256,uint256)"));
        assertEq(pool.queueEntry.selector, bytes4(keccak256("queueEntry(uint256)")));
        assertEq(pool.rootSeqOf.selector, bytes4(keccak256("rootSeqOf(bytes32)")));
    }
}

/// processQueue with stand-in append verifiers, so the count rules and root bookkeeping run without a prover.
contract ShieldedPoolQueueTest is Test {
    ShieldedPool internal pool;
    MockERC20 internal usd;
    InputBoundVerifier internal pinned;
    address internal alice = makeAddr("alice");
    uint256 internal nextInner = 1;

    function setUp() public {
        usd = new MockERC20("Test USDG", "tUSDG", 6, type(uint256).max);
        pinned = new InputBoundVerifier();
        pool = _pool(IHonkVerifier(address(new AcceptAllVerifier())));
    }

    function _pool(IHonkVerifier append) internal returns (ShieldedPool p) {
        address[] memory assets = new address[](1);
        assets[0] = address(usd);
        p = new ShieldedPool(append, IHonkVerifier(address(new AcceptAllVerifier())), assets);
        usd.mintTo(alice, 1_000_000e6);
        vm.prank(alice);
        usd.approve(address(p), type(uint256).max);
    }

    function _shield(ShieldedPool p, uint256 n) internal {
        for (uint256 i; i < n; i++) {
            vm.prank(alice);
            p.shield(address(usd), 1e6, bytes32(nextInner++));
        }
    }

    /// The vector a prover commits to for the next `count` entries, built the way processQueue builds it.
    function _inputs(ShieldedPool p, bytes32 newRoot, uint256 count) internal view returns (bytes32[] memory inputs) {
        uint256 batch = p.APPEND_BATCH();
        uint256 start = p.processed();
        inputs = new bytes32[](4 + 4 * batch);
        inputs[0] = bytes32(p.deploymentId());
        inputs[1] = p.root();
        inputs[2] = newRoot;
        inputs[3] = bytes32(start);
        for (uint256 i; i < count; i++) {
            ShieldedPool.Entry memory e = p.queueEntry(start + i);
            inputs[4 + i] = bytes32(uint256(e.kind));
            inputs[4 + batch + i] = e.a;
            inputs[4 + 2 * batch + i] = e.b;
            inputs[4 + 3 * batch + i] = e.c;
        }
    }

    function test_processQueueRejectsZeroCount() public {
        _shield(pool, 2);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.BadCount.selector, 0, 2));
        pool.processQueue("", bytes32(uint256(1)), 0);
    }

    function test_processQueueRejectsCountAbovePending() public {
        _shield(pool, 2);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.BadCount.selector, 3, 2));
        pool.processQueue("", bytes32(uint256(1)), 3);
    }

    function test_processQueueRejectsCountAboveBatch() public {
        _shield(pool, 9);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.BadCount.selector, 9, 9));
        pool.processQueue("", bytes32(uint256(1)), 9);
    }

    function test_partialBatchLeavesRestQueued() public {
        _shield(pool, 5);
        vm.expectEmit(address(pool));
        emit ShieldedPool.RootUpdated(bytes32(uint256(1)), 2, 0, 3);
        pool.processQueue("", bytes32(uint256(1)), 3);
        assertEq(pool.processed(), 3);
        assertEq(pool.queueLength(), 5);
        pool.processQueue("", bytes32(uint256(2)), 2);
        assertEq(pool.processed(), 5);
        assertEq(pool.rootSeqOf(bytes32(uint256(2))), 3);
    }

    /// Audit #19: a shield landing between proving and inclusion used to change the batch size and so the public inputs.
    function test_laterShieldDoesNotInvalidateInFlightAppend() public {
        ShieldedPool p = _pool(IHonkVerifier(address(pinned)));
        _shield(p, 3);
        bytes32 newRoot = bytes32(uint256(77));
        pinned.bind(_inputs(p, newRoot, 3));
        _shield(p, 1);
        p.processQueue("", newRoot, 3);
        assertEq(p.processed(), 3);
        assertEq(p.root(), newRoot);
        assertEq(p.queueLength(), 4);
    }

    function test_appendVerifierSeesOnlyTheNamedEntries() public {
        ShieldedPool p = _pool(IHonkVerifier(address(pinned)));
        _shield(p, 3);
        pinned.bind(_inputs(p, bytes32(uint256(77)), 2));
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        p.processQueue("", bytes32(uint256(77)), 3);
        p.processQueue("", bytes32(uint256(77)), 2);
        assertEq(p.processed(), 2);
    }

    /// Roots age out of isKnownRoot, but rootSeqOf keeps every root's sequence for scanners that resume from an old root.
    function test_rootSeqOfIsNeverPruned() public {
        uint256 updates = pool.ROOT_HISTORY() + 6;
        for (uint256 i = 1; i <= updates; i++) {
            _shield(pool, 1);
            pool.processQueue("", bytes32(i), 1);
        }
        assertFalse(pool.isKnownRoot(bytes32(uint256(1))), "old root expired from history");
        assertFalse(pool.isKnownRoot(pool.EMPTY_ROOT()));
        assertEq(pool.rootSeqOf(pool.EMPTY_ROOT()), 1);
        assertEq(pool.rootSeqOf(bytes32(uint256(1))), 2);
        assertEq(pool.rootSeqOf(bytes32(updates)), updates + 1);
        assertEq(pool.rootSeq(), updates + 1);
    }
}
