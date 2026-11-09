// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MockERC20} from "../../src/tokens/MockERC20.sol";
import {AppendVerifier} from "../../src/privacy/verifiers/AppendVerifier.sol";
import {SpendVerifier} from "../../src/privacy/verifiers/SpendVerifier.sol";
import {ShieldedPool, IHonkVerifier} from "../../src/privacy/ShieldedPool.sol";

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
        pool.processQueue("", bytes32(0));
    }

    function test_processQueueRejectsGarbageProof() public {
        vm.prank(alice);
        pool.shield(address(usd), 1e6, bytes32(uint256(7)));
        vm.expectRevert();
        pool.processQueue(new bytes(9000), bytes32(uint256(1)));
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

    /// Root expiry after ROOT_HISTORY batches needs 64 proven appends and is not covered here yet.
    function test_unrecordedRootIsUnknown() public view {
        assertFalse(pool.isKnownRoot(bytes32(uint256(99))));
    }
}
