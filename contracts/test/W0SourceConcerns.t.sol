// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Fixture} from "./utils/Fixture.sol";
import {Types} from "../src/lib/Types.sol";
import {ClearingHouse} from "../src/perps/ClearingHouse.sol";

/// Reproductions for the two source concerns PRIVATE_V1_ADDENDUM section 15 requires before freeze.
/// Dispositions are recorded in docs/privacy/ADR-P09-funding-and-loss.md and ADR-P10-governance.md.
contract W0SourceConcernsTest is Fixture {
    bytes32 internal constant LOCKED_ROLE = keccak256("LOCKED_ROLE");

    /// Concern 2: LOCKED_ROLE's own admin must not be reachable, or the default admin can grant itself
    /// LOCKED_ROLE and then the wired PREFLIGHT/CLEARING_HOUSE roles.
    function test_defaultAdminCannotReachLockedRole() public {
        assertEq(registry.getRoleAdmin(registry.PREFLIGHT_ROLE()), LOCKED_ROLE);
        assertEq(registry.getRoleAdmin(registry.CLEARING_HOUSE_ROLE()), LOCKED_ROLE);
        assertEq(registry.getRoleAdmin(LOCKED_ROLE), LOCKED_ROLE, "LOCKED_ROLE must administer itself");

        vm.startPrank(admin);
        vm.expectRevert();
        registry.grantRole(LOCKED_ROLE, admin);
        vm.stopPrank();
        assertFalse(registry.hasRole(LOCKED_ROLE, admin));
    }

    /// Concern 1: FundingSettled must report what actually moved, separately from what was owed.
    function test_fundingSettledReportsPaidSeparatelyFromOwed() public {
        _deposit(trader, 50_000e6);
        _open(trader, 0.1e18, 3_000e6, 1);
        vm.prank(maker);
        ch.makerTopUp(marketId, trader, 9_000e6);
        _setPrice(130_000);
        vm.prank(trader);
        ch.removeMargin(marketId, 3_000e6);

        vm.warp(vm.getBlockTimestamp() + 3600);
        _setPrice(130_000);
        uint256 unpaidBefore = ch.unpaidFunding(marketId);
        vm.recordLogs();
        ch.settleFunding(marketId, trader);
        uint256 shortfall = ch.unpaidFunding(marketId) - unpaidBefore;
        assertGt(shortfall, 0, "scenario must produce a shortfall");

        bytes32 topic = keccak256("FundingSettled(bytes32,address,address,int256,int256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] != topic) continue;
            (int256 owed, int256 paid) = abi.decode(logs[i].data, (int256, int256));
            assertGt(owed, 0, "long pays on long skew");
            assertEq(uint256(owed) - uint256(paid), shortfall, "owed - paid == recorded shortfall");
            found = true;
        }
        assertTrue(found, "FundingSettled(owed, paid) emitted");
    }

    /// Disposition check: a funding shortfall is written off, never collected later from the pair and
    /// never charged to insurance or the bond. Closing the pair leaves the recorded total unchanged.
    function test_fundingShortfallIsWrittenOffAtClose() public {
        _deposit(trader, 50_000e6);
        _open(trader, 0.1e18, 3_000e6, 1);
        vm.prank(maker);
        ch.makerTopUp(marketId, trader, 9_000e6);
        _setPrice(130_000);
        vm.prank(trader);
        ch.removeMargin(marketId, 3_000e6);
        vm.warp(vm.getBlockTimestamp() + 3600);
        _setPrice(130_000);
        ch.settleFunding(marketId, trader);
        uint256 unpaid = ch.unpaidFunding(marketId);
        assertGt(unpaid, 0);

        uint256 px = 130_000 * WAD;
        Types.Quote memory q = _quote(trader, -0.1e18, px, 2);
        bytes memory sig = _sign(q);
        vm.prank(trader);
        ch.trade(q, sig, _params(-0.1e18, 0, 0));

        assertEq(ch.getPair(marketId, trader).size, 0, "closed");
        assertEq(ch.unpaidFunding(marketId), unpaid, "write-off total is not collected at close");
        assertEq(ch.badDebt(marketId), 0, "shortfall is not bad debt");
        _assertConservation();
    }
}
