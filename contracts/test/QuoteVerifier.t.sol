// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {Types} from "../src/lib/Types.sol";
import {QuoteVerifier} from "../src/perps/QuoteVerifier.sol";
import {ClearingHouse} from "../src/perps/ClearingHouse.sol";

/// T-009 quote expiry and replay fail, T-010 partial fills cannot exceed the signed max,
/// plus chain/domain replay, tampering, wrong taker and signer revocation.
contract QuoteVerifierTest is Fixture {
    uint256 internal px;

    function setUp() public override {
        super.setUp();
        px = BTC_PRICE * WAD;
        _deposit(trader, 50_000e6);
        _deposit(trader2, 50_000e6);
    }

    function test_T009_replayOfFilledQuoteReverts() public {
        Types.Quote memory q = _quote(trader, 0.1e18, px, 7);
        bytes memory sig = _sign(q);
        vm.startPrank(trader);
        ch.trade(q, sig, _params(0.1e18, 4_000e6, px));
        vm.expectRevert(abi.encodeWithSelector(QuoteVerifier.NonceUsed.selector, maker, 7));
        ch.trade(q, sig, _params(0.1e18, 4_000e6, px));
        vm.stopPrank();
    }

    function test_T009_expiredQuoteReverts() public {
        Types.Quote memory q = _quote(trader, 0.1e18, px, 8);
        bytes memory sig = _sign(q);
        vm.warp(q.deadline + 1);
        _setPrice(BTC_PRICE);
        Types.TradeParams memory p = _params(0.1e18, 4_000e6, px);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(QuoteVerifier.QuoteExpired.selector, q.deadline));
        ch.trade(q, sig, p);
    }

    function test_T010_partialFillsCannotExceedSignedSize() public {
        Types.Quote memory q = _quote(address(0), 0.3e18, px, 9);
        bytes memory sig = _sign(q);
        vm.prank(trader);
        ch.trade(q, sig, _params(0.2e18, 8_000e6, px));
        vm.prank(trader2);
        vm.expectRevert(abi.encodeWithSelector(QuoteVerifier.OverFill.selector, 0.2e18, 0.2e18, 0.3e18));
        ch.trade(q, sig, _params(0.2e18, 8_000e6, px));
        vm.prank(trader2);
        ch.trade(q, sig, _params(0.1e18, 4_000e6, px));
        assertEq(ch.quoteFilled(ch.hashQuote(q)), 0.3e18);
        vm.prank(trader2);
        vm.expectRevert(abi.encodeWithSelector(QuoteVerifier.NonceUsed.selector, maker, 9));
        ch.trade(q, sig, _params(0.01e18, 400e6, px));
    }

    function testFuzz_T010_fillsNeverExceedSigned(uint64 a, uint64 b) public {
        uint256 total = 0.4e18;
        uint256 f1 = bound(a, 0.001e18, total);
        uint256 f2 = bound(b, 0.001e18, total);
        Types.Quote memory q = _quote(address(0), int256(total), px, 10);
        bytes memory sig = _sign(q);
        vm.prank(trader);
        ch.trade(q, sig, _params(int256(f1), 20_000e6, px));
        vm.prank(trader2);
        if (f1 + f2 > total) {
            vm.expectRevert();
        }
        ch.trade(q, sig, _params(int256(f2), 20_000e6, px));
        assertLe(ch.quoteFilled(ch.hashQuote(q)), total);
    }

    function test_tamperedQuoteFailsSignature() public {
        Types.Quote memory q = _quote(trader, 0.1e18, px, 11);
        bytes memory sig = _sign(q);
        q.price = px - 1e18;
        vm.prank(trader);
        vm.expectRevert(QuoteVerifier.BadSignature.selector);
        ch.trade(q, sig, _params(0.1e18, 4_000e6, px));
    }

    function test_wrongTakerReverts() public {
        Types.Quote memory q = _quote(trader, 0.1e18, px, 12);
        bytes memory sig = _sign(q);
        vm.prank(trader2);
        vm.expectRevert(abi.encodeWithSelector(QuoteVerifier.WrongTaker.selector, trader, trader2));
        ch.trade(q, sig, _params(0.1e18, 4_000e6, px));
    }

    function test_crossChainReplayFails() public {
        Types.Quote memory q = _quote(trader, 0.1e18, px, 13);
        bytes memory sig = _sign(q);
        vm.chainId(4663);
        _setPrice(BTC_PRICE);
        vm.prank(trader);
        vm.expectRevert(QuoteVerifier.BadSignature.selector);
        ch.trade(q, sig, _params(0.1e18, 4_000e6, px));
    }

    function test_signatureForAnotherClearingHouseFails() public {
        ClearingHouse other =
            new ClearingHouse(address(vault), address(registry), address(oracle), address(backstop), feeRecipient);
        Types.Quote memory q = _quote(trader, 0.1e18, px, 14);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, other.hashQuote(q));
        vm.prank(trader);
        vm.expectRevert(QuoteVerifier.BadSignature.selector);
        ch.trade(q, abi.encodePacked(r, s, v), _params(0.1e18, 4_000e6, px));
    }

    function test_cancelledNonceCannotFill() public {
        Types.Quote memory q = _quote(trader, 0.1e18, px, 15);
        bytes memory sig = _sign(q);
        vm.prank(maker);
        ch.cancelNonce(15);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(QuoteVerifier.NonceUsed.selector, maker, 15));
        ch.trade(q, sig, _params(0.1e18, 4_000e6, px));
    }

    function test_nonceFloorInvalidatesOlderQuotes() public {
        Types.Quote memory q = _quote(trader, 0.1e18, px, 16);
        bytes memory sig = _sign(q);
        vm.prank(maker);
        ch.raiseNonceFloor(100);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(QuoteVerifier.NonceUsed.selector, maker, 16));
        ch.trade(q, sig, _params(0.1e18, 4_000e6, px));
    }

    function test_delegatedSignerWorksAndRevocationIsImmediate() public {
        uint256 hotKey = 0xB0B;
        vm.prank(maker);
        ch.setQuoteSigner(vm.addr(hotKey));

        Types.Quote memory q = _quote(trader, 0.1e18, px, 17);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(hotKey, ch.hashQuote(q));
        vm.prank(trader);
        ch.trade(q, abi.encodePacked(r, s, v), _params(0.1e18, 4_000e6, px));

        vm.prank(maker);
        ch.setQuoteSigner(address(0));
        Types.Quote memory q2 = _quote(trader, 0.1e18, px, 18);
        (v, r, s) = vm.sign(hotKey, ch.hashQuote(q2));
        vm.prank(trader);
        vm.expectRevert(QuoteVerifier.BadSignature.selector);
        ch.trade(q2, abi.encodePacked(r, s, v), _params(0.1e18, 4_000e6, px));
    }

    function test_policyVersionMismatchReverts() public {
        Types.Quote memory q = _quote(trader, 0.1e18, px, 19);
        q.policyVersion = 2;
        bytes memory sig = _sign(q);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(QuoteVerifier.PolicyVersionMismatch.selector, 2, 1));
        ch.trade(q, sig, _params(0.1e18, 4_000e6, px));
    }

    function test_fillDirectionMustMatchQuote() public {
        Types.Quote memory q = _quote(trader, 0.1e18, px, 20);
        bytes memory sig = _sign(q);
        vm.prank(trader);
        vm.expectRevert(QuoteVerifier.DirectionMismatch.selector);
        ch.trade(q, sig, _params(-0.1e18, 4_000e6, 0));
    }
}
