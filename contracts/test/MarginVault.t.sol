// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {MarginVault} from "../src/perps/MarginVault.sol";
import {MockERC20} from "../src/tokens/MockERC20.sol";
import {FeeOnTransferToken} from "./utils/AdversarialTokens.sol";

/// T-001 collateral conservation, T-002 locked margin never withdraws.
contract MarginVaultTest is Fixture {
    function test_T001_depositWithdrawConservesTokenUnits() public {
        uint256 walletBefore = usd.balanceOf(trader);
        _deposit(trader, 12_345e6);
        assertEq(vault.balanceOf(vault.FREE(), trader), 12_345e6);
        assertEq(usd.balanceOf(trader), walletBefore - 12_345e6);
        _assertConservation();

        vm.prank(trader);
        vault.withdraw(12_345e6, trader);
        assertEq(usd.balanceOf(trader), walletBefore);
        assertEq(vault.balanceOf(vault.FREE(), trader), 0);
        _assertConservation();
    }

    function testFuzz_T001_depositWithdrawSequence(uint96 a, uint96 b, uint96 w) public {
        uint256 da = bound(a, 1, 50_000e6);
        uint256 db = bound(b, 1, 50_000e6);
        _deposit(trader, da);
        _deposit(trader2, db);
        uint256 ww = bound(w, 0, da);
        if (ww != 0) {
            vm.prank(trader);
            vault.withdraw(ww, trader);
        }
        assertEq(vault.balanceOf(vault.FREE(), trader), da - ww);
        _assertConservation();
    }

    function test_T002_cannotWithdrawMoreThanFree() public {
        _deposit(trader, 1_000e6);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(MarginVault.InsufficientBalance.selector, 1_000e6, 1_001e6));
        vault.withdraw(1_001e6, trader);
    }

    function test_T002_marginLockedInPositionIsNotWithdrawable() public {
        _deposit(trader, 10_000e6);
        _open(trader, 0.1e18, 6_000e6, 1);
        assertEq(vault.balanceOf(vault.FREE(), trader), 10_000e6 - 6_000e6 - _fee(0.1e18), "free after open");
        assertEq(vault.lockedOf(trader), 6_000e6, "locked");

        uint256 free = vault.balanceOf(vault.FREE(), trader);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(MarginVault.InsufficientBalance.selector, free, free + 1));
        vault.withdraw(free + 1, trader);
        _assertConservation();
    }

    function test_T002_makerCommittedBackingCannotDropBelowMinimumWhileActive() public {
        uint256 committed = vault.balanceOf(ch.commitDomain(marketId), maker);
        vm.prank(maker);
        vm.expectRevert();
        ch.withdrawBacking(marketId, committed - MIN_BACKING + 1);

        vm.prank(maker);
        ch.withdrawBacking(marketId, committed - MIN_BACKING);
        assertEq(vault.balanceOf(ch.commitDomain(marketId), maker), MIN_BACKING);
        _assertConservation();
    }

    function test_onlyWiredOperatorsCanMoveLedger() public {
        _deposit(trader, 100e6);
        bytes32 free = vault.FREE();
        vm.expectRevert(MarginVault.NotOperator.selector);
        vault.move(free, trader, free, address(this), 100e6);
    }

    function test_operatorsCanOnlyBeWiredOnce() public {
        vm.expectRevert(MarginVault.AlreadyWired.selector);
        vault.wireOperators(address(this), address(this));
    }

    function test_feeOnTransferCollateralIsRejected() public {
        FeeOnTransferToken bad = new FeeOnTransferToken();
        MarginVault badVault = new MarginVault(address(bad), address(this));
        bad.mintTo(trader, 1_000e18);
        vm.startPrank(trader);
        bad.approve(address(badVault), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(MarginVault.BalanceDeltaMismatch.selector, 100e18, 99e18));
        badVault.deposit(100e18, trader);
        vm.stopPrank();
    }

    function test_rejectsCollateralAbove18Decimals() public {
        MockERC20 weird = new MockERC20("Mock 24", "M24", 24, 0);
        vm.expectRevert(MarginVault.UnsupportedDecimals.selector);
        new MarginVault(address(weird), address(this));
    }

    function test_donationDoesNotCreateLedgerCredit() public {
        usd.mintTo(address(this), 500e6);
        usd.transfer(address(vault), 500e6);
        assertEq(vault.totalLedger() + 500e6, usd.balanceOf(address(vault)));
    }

    function _fee(int256 size) internal view returns (uint256) {
        uint256 abs = size < 0 ? uint256(-size) : uint256(size);
        uint256 notionalWad = abs * BTC_PRICE;
        uint256 feeWad = notionalWad * 6 / 10_000;
        return (feeWad + 1e12 - 1) / 1e12;
    }
}
