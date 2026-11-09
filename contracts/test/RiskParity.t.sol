// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {RiskMath} from "../src/lib/RiskMath.sol";
import {SpotMath} from "../src/lib/SpotMath.sol";
import {Types} from "../src/lib/Types.sol";

/// @notice T-015: the Rust risk kernel and the Solidity implementation must agree exactly.
/// @dev Vectors come from `cargo run --bin gen-vectors` (crates/risk-kernel). Struct fields are in
///      alphabetical order because Foundry decodes JSON objects by sorted key.
contract RiskParityTest is Fixture {
    struct MarginCase {
        string absSize;
        string expected;
        string fraction;
        string price;
        string scale;
    }

    struct FeeCase {
        string absSize;
        string bps;
        string expected;
        string price;
        string scale;
    }

    struct PnlCase {
        string entry;
        string exit;
        string floor;
        string scale;
        string size;
        string trunc;
    }

    struct EntryCase {
        string absAdd;
        string absOld;
        string addPrice;
        string expected;
        string oldEntry;
    }

    struct RateCase {
        string expected;
        string longOi;
        string maxPerHour;
        string shortOi;
    }

    struct FundingCase {
        string delta;
        string dt;
        string owed;
        string price;
        string rate;
        string scale;
        string size;
    }

    struct AmountOutCase {
        string amountIn;
        string expected;
        string feeBps;
        string reserveIn;
        string reserveOut;
    }

    struct SqrtCase {
        string expected;
        string x;
    }

    struct LifeExpected {
        string entryPrice;
        string fees;
        string fundingIndex;
        string makerCommit;
        string makerMargin;
        string size;
        string takerFree;
        string takerMargin;
    }

    struct LifeStep {
        string kind;
        string margin;
        string mark;
        string price;
        string secs;
        string size;
    }

    struct Lifecycle {
        LifeExpected expected;
        string name;
        LifeStep[] steps;
    }

    function _vectors() internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/risk_vectors.json"));
    }

    function _u(string memory x) internal pure returns (uint256) {
        return vm.parseUint(x);
    }

    function _i(string memory x) internal pure returns (int256) {
        return vm.parseInt(x);
    }

    function test_T015_marginRequirementParity() public view {
        MarginCase[] memory cs = abi.decode(vm.parseJsonTypeArray(_vectors(), ".cases.marginRequirement", "MarginCase(string absSize,string expected,string fraction,string price,string scale)"), (MarginCase[]));
        for (uint256 i; i < cs.length; ++i) {
            assertEq(
                RiskMath.marginRequirement(_u(cs[i].absSize), _u(cs[i].price), _u(cs[i].fraction), _u(cs[i].scale)),
                _u(cs[i].expected),
                vm.toString(i)
            );
        }
        assertEq(cs.length, 200);
    }

    function test_T015_feeParity() public view {
        FeeCase[] memory cs = abi.decode(vm.parseJsonTypeArray(_vectors(), ".cases.fee", "FeeCase(string absSize,string bps,string expected,string price,string scale)"), (FeeCase[]));
        for (uint256 i; i < cs.length; ++i) {
            assertEq(
                RiskMath.fee(_u(cs[i].absSize), _u(cs[i].price), _u(cs[i].bps), _u(cs[i].scale)),
                _u(cs[i].expected),
                vm.toString(i)
            );
        }
        assertEq(cs.length, 200);
    }

    function test_T015_pnlParity() public view {
        PnlCase[] memory cs = abi.decode(vm.parseJsonTypeArray(_vectors(), ".cases.pnl", "PnlCase(string entry,string exit,string floor,string scale,string size,string trunc)"), (PnlCase[]));
        for (uint256 i; i < cs.length; ++i) {
            int256 size = _i(cs[i].size);
            uint256 entry = _u(cs[i].entry);
            uint256 exit = _u(cs[i].exit);
            uint256 sc = _u(cs[i].scale);
            assertEq(RiskMath.pnlTrunc(size, entry, exit, sc), _i(cs[i].trunc), string.concat("trunc ", vm.toString(i)));
            assertEq(RiskMath.pnlFloor(size, entry, exit, sc), _i(cs[i].floor), string.concat("floor ", vm.toString(i)));
        }
        assertEq(cs.length, 300);
    }

    function test_T015_weightedEntryParity() public view {
        EntryCase[] memory cs = abi.decode(vm.parseJsonTypeArray(_vectors(), ".cases.weightedEntry", "EntryCase(string absAdd,string absOld,string addPrice,string expected,string oldEntry)"), (EntryCase[]));
        for (uint256 i; i < cs.length; ++i) {
            assertEq(
                RiskMath.weightedEntry(_u(cs[i].absOld), _u(cs[i].oldEntry), _u(cs[i].absAdd), _u(cs[i].addPrice)),
                _u(cs[i].expected),
                vm.toString(i)
            );
        }
    }

    function test_T015_fundingParity() public view {
        RateCase[] memory rs = abi.decode(vm.parseJsonTypeArray(_vectors(), ".cases.fundingRate", "RateCase(string expected,string longOi,string maxPerHour,string shortOi)"), (RateCase[]));
        for (uint256 i; i < rs.length; ++i) {
            assertEq(
                RiskMath.fundingRatePerSecond(_u(rs[i].longOi), _u(rs[i].shortOi), _u(rs[i].maxPerHour)),
                _i(rs[i].expected),
                string.concat("rate ", vm.toString(i))
            );
        }
        FundingCase[] memory fs = abi.decode(vm.parseJsonTypeArray(_vectors(), ".cases.funding", "FundingCase(string delta,string dt,string owed,string price,string rate,string scale,string size)"), (FundingCase[]));
        for (uint256 i; i < fs.length; ++i) {
            int256 delta = RiskMath.fundingIndexDelta(_i(fs[i].rate), _u(fs[i].dt), _u(fs[i].price));
            assertEq(delta, _i(fs[i].delta), string.concat("delta ", vm.toString(i)));
            assertEq(
                RiskMath.fundingOwed(_i(fs[i].size), delta, _u(fs[i].scale)),
                _i(fs[i].owed),
                string.concat("owed ", vm.toString(i))
            );
        }
    }

    function test_T015_spotParity() public view {
        AmountOutCase[] memory cs = abi.decode(vm.parseJsonTypeArray(_vectors(), ".cases.amountOut", "AmountOutCase(string amountIn,string expected,string feeBps,string reserveIn,string reserveOut)"), (AmountOutCase[]));
        for (uint256 i; i < cs.length; ++i) {
            assertEq(
                SpotMath.getAmountOut(
                    _u(cs[i].amountIn), _u(cs[i].reserveIn), _u(cs[i].reserveOut), _u(cs[i].feeBps)
                ),
                _u(cs[i].expected),
                vm.toString(i)
            );
        }
        SqrtCase[] memory ss = abi.decode(vm.parseJsonTypeArray(_vectors(), ".cases.sqrt", "SqrtCase(string expected,string x)"), (SqrtCase[]));
        for (uint256 i; i < ss.length; ++i) {
            assertEq(SpotMath.sqrt(_u(ss[i].x)), _u(ss[i].expected), string.concat("sqrt ", vm.toString(i)));
        }
    }

    /// Replays each Rust lifecycle through the real ClearingHouse and compares every ledger entry.
    function test_T015_lifecycleParity() public {
        Lifecycle[] memory ls = abi.decode(
            vm.parseJsonTypeArray(
                _vectors(),
                ".cases.lifecycles",
                "Lifecycle(LifeExpected expected,string name,LifeStep[] steps)LifeExpected(string entryPrice,string fees,string fundingIndex,string makerCommit,string makerMargin,string size,string takerFree,string takerMargin)LifeStep(string kind,string margin,string mark,string price,string secs,string size)"
            ),
            (Lifecycle[])
        );
        assertEq(ls.length, 2);
        for (uint256 i; i < ls.length; ++i) {
            if (i > 0) setUp();
            _deposit(trader, 50_000e6);
            _replay(ls[i]);
        }
    }

    function _replay(Lifecycle memory l) internal {
        uint256 nonce = 500;
        for (uint256 j; j < l.steps.length; ++j) {
            LifeStep memory st = l.steps[j];
            uint256 kind = _u(st.kind);
            uint256 mark = _u(st.mark);
            if (kind == 1) {
                vm.warp(vm.getBlockTimestamp() + _u(st.secs));
                _setPrice(mark / WAD);
                continue;
            }
            _setPrice(mark / WAD);
            if (kind == 2) {
                ch.settleFunding(marketId, trader);
                continue;
            }
            int256 size = _i(st.size);
            uint256 price = _u(st.price);
            Types.Quote memory q = _quote(trader, size, price, nonce++);
            bytes memory sig = _sign(q);
            vm.prank(trader);
            ch.trade(q, sig, _params(size, _u(st.margin), size > 0 ? price : 0));
        }

        Types.PairView memory v = ch.getPair(marketId, trader);
        LifeExpected memory e = l.expected;
        assertEq(v.size, _i(e.size), string.concat(l.name, ": size"));
        assertEq(v.entryPrice, _u(e.entryPrice), string.concat(l.name, ": entry"));
        assertEq(v.takerMargin, _u(e.takerMargin), string.concat(l.name, ": taker margin"));
        assertEq(v.makerMargin, _u(e.makerMargin), string.concat(l.name, ": maker margin"));
        assertEq(vault.balanceOf(vault.FREE(), trader), _u(e.takerFree), string.concat(l.name, ": taker free"));
        assertEq(
            vault.balanceOf(ch.commitDomain(marketId), maker), _u(e.makerCommit), string.concat(l.name, ": commit")
        );
        assertEq(vault.balanceOf(ch.FEES_DOMAIN(), address(0)), _u(e.fees), string.concat(l.name, ": fees"));
        assertEq(ch.fundingIndex(marketId), _i(e.fundingIndex), string.concat(l.name, ": funding index"));
        _assertConservation();
    }
}
