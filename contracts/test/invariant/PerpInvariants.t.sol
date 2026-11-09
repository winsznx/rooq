// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Fixture} from "../utils/Fixture.sol";
import {Types} from "../../src/lib/Types.sol";
import {ClearingHouse} from "../../src/perps/ClearingHouse.sol";
import {MarginVault} from "../../src/perps/MarginVault.sol";
import {MockERC20} from "../../src/tokens/MockERC20.sol";
import {MockPriceFeed} from "../../src/oracle/MockPriceFeed.sol";
import {MarketBackstop} from "../../src/perps/MarketBackstop.sol";

/// @notice Drives random but valid sequences of trader, maker, keeper and oracle actions.
contract PerpHandler is Test {
    uint256 internal constant WAD = 1e18;
    ClearingHouse internal ch;
    MarginVault internal vault;
    MockERC20 internal usd;
    MockPriceFeed internal feed;
    MarketBackstop internal backstop;
    bytes32 internal marketId;
    uint256 internal makerKey;
    address internal maker;
    address internal feedOperator;
    address[] public traders;
    uint256 internal nonce = 1_000;
    uint256 public price = 60_000;

    uint256 public trades;
    uint256 public attempts;
    uint256 public rejectedTrades;
    bytes public lastTradeError;
    uint256 public liquidations;
    uint256 public rejectedLiquidations;
    uint256 public fundingSettles;

    constructor(
        ClearingHouse ch_,
        MarginVault vault_,
        MockERC20 usd_,
        MockPriceFeed feed_,
        MarketBackstop backstop_,
        bytes32 marketId_,
        uint256 makerKey_,
        address feedOperator_
    ) {
        ch = ch_;
        vault = vault_;
        usd = usd_;
        feed = feed_;
        backstop = backstop_;
        marketId = marketId_;
        makerKey = makerKey_;
        maker = vm.addr(makerKey_);
        feedOperator = feedOperator_;
        for (uint256 i; i < 3; ++i) {
            traders.push(makeAddr(string(abi.encodePacked("inv-trader-", vm.toString(i)))));
        }
    }

    function traderCount() external view returns (uint256) {
        return traders.length;
    }

    function deposit(uint256 who, uint256 amount) external {
        address t = traders[who % traders.length];
        amount = bound(amount, 1e6, 50_000e6);
        usd.transfer(t, amount);
        vm.startPrank(t);
        usd.approve(address(vault), amount);
        vault.deposit(amount, t);
        vm.stopPrank();
    }

    function withdraw(uint256 who, uint256 amount) external {
        address t = traders[who % traders.length];
        uint256 free = vault.balanceOf(vault.FREE(), t);
        if (free == 0) return;
        amount = bound(amount, 1, free);
        vm.prank(t);
        vault.withdraw(amount, t);
    }

    function trade(uint256 who, int256 sizeSeed, uint256 marginSeed, uint256 slipBps) external {
        address t = traders[who % traders.length];
        Types.PairView memory v = ch.getPair(marketId, t);
        int256 size = _size(v.size, sizeSeed);
        Types.Quote memory q = _quote(t, size, bound(slipBps, 0, 150));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(makerKey, ch.hashQuote(q));
        Types.TradeParams memory p = Types.TradeParams({
            fillSize: size,
            marginDeposit: _margin(t, v.size, size, marginSeed),
            limitPrice: size > 0 ? type(uint256).max : 0,
            maxFeeBps: 100,
            deadline: uint64(vm.getBlockTimestamp() + 30)
        });
        attempts++;
        vm.prank(t);
        try ch.trade(q, abi.encodePacked(r, s, vv), p) {
            trades++;
        } catch (bytes memory reason) {
            rejectedTrades++;
            lastTradeError = reason;
        }
    }

    function _size(int256 current, int256 seed) internal pure returns (int256 size) {
        uint256 mag = bound(seed == type(int256).min ? 1 : (seed < 0 ? uint256(-seed) : uint256(seed)), 0.001e18, 0.5e18);
        size = seed < 0 ? -int256(mag) : int256(mag);
        if (current != 0 && (current > 0) != (size > 0)) {
            uint256 cap = current > 0 ? uint256(current) : uint256(-current);
            if (mag > cap) size = size > 0 ? int256(cap) : -int256(cap);
        }
    }

    function _quote(address t, int256 size, uint256 slipBps) internal returns (Types.Quote memory q) {
        uint256 px = price * WAD;
        q = Types.Quote({
            marketId: marketId,
            maker: maker,
            taker: t,
            size: size,
            price: size > 0 ? px + (px * slipBps) / 10_000 : px - (px * slipBps) / 10_000,
            minFill: 0,
            nonce: nonce++,
            deadline: uint64(vm.getBlockTimestamp() + 30),
            policyVersion: 1
        });
    }

    /// @dev Tops the trader up, then posts between 1x and 2x initial margin (50% IMR) on increases.
    function _margin(address t, int256 current, int256 size, uint256 seed) internal returns (uint256 margin) {
        uint256 free = vault.balanceOf(vault.FREE(), t);
        if (free < 20_000e6) {
            usd.transfer(t, 40_000e6);
            vm.startPrank(t);
            usd.approve(address(vault), 40_000e6);
            vault.deposit(40_000e6, t);
            vm.stopPrank();
            free += 40_000e6;
        }
        if (current != 0 && (current > 0) != (size > 0)) return 0;
        uint256 absSize = size > 0 ? uint256(size) : uint256(-size);
        uint256 im = (absSize * price) / 2 / 1e12 + 1e6;
        margin = im + bound(seed, 0, im);
        if (margin > free) margin = free;
    }

    function movePrice(uint256 bps, bool up) external {
        bps = bound(bps, 0, 1_500);
        uint256 delta = (price * bps) / 10_000;
        price = up ? price + delta : price - delta;
        if (price > 150_000) price = 150_000;
        if (price < 20_000) price = 20_000;
        vm.prank(feedOperator);
        feed.setAnswer(int256(price * 1e8));
    }

    function warp(uint256 secs) external {
        secs = bound(secs, 1, 2 hours);
        vm.warp(vm.getBlockTimestamp() + secs);
        vm.prank(feedOperator);
        feed.setAnswer(int256(price * 1e8));
    }

    function settleFunding(uint256 who) external {
        address t = traders[who % traders.length];
        if (ch.getPair(marketId, t).size == 0) return;
        ch.settleFunding(marketId, t);
        fundingSettles++;
    }

    function liquidate(uint256 who) external {
        address t = traders[who % traders.length];
        if (ch.getPair(marketId, t).size == 0) return;
        try ch.liquidate(marketId, t) {
            liquidations++;
        } catch {
            rejectedLiquidations++;
        }
    }
}

/// @notice I-01 conservation, I-02 counterparty balance, T-006 insurance >= 0 and per-pair accounting.
contract PerpInvariantsTest is Fixture {
    PerpHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new PerpHandler(ch, vault, usd, feed, backstop, marketId, makerKey, admin);
        usd.mintTo(address(handler), 1_000_000_000e6);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = PerpHandler.deposit.selector;
        selectors[1] = PerpHandler.withdraw.selector;
        selectors[2] = PerpHandler.trade.selector;
        selectors[3] = PerpHandler.movePrice.selector;
        selectors[4] = PerpHandler.warp.selector;
        selectors[5] = PerpHandler.settleFunding.selector;
        selectors[6] = PerpHandler.liquidate.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        excludeSender(address(vault));
    }

    /// I-01: the ledger never claims more collateral than the vault holds.
    function invariant_ledgerEqualsTokenBalance() public view {
        assertEq(vault.totalLedger(), usd.balanceOf(address(vault)));
    }

    /// I-02: open interest equals the sum of matched taker sizes; each pair's maker is exactly opposite.
    function invariant_openInterestMatchesPairs() public view {
        (uint256 longOi, uint256 shortOi) = ch.openInterest(marketId);
        uint256 sumLong;
        uint256 sumShort;
        for (uint256 i; i < handler.traderCount(); ++i) {
            Types.PairView memory v = ch.getPair(marketId, handler.traders(i));
            if (v.size > 0) sumLong += uint256(v.size);
            else sumShort += uint256(-v.size);
            if (v.size == 0) {
                assertEq(v.takerMargin, 0, "closed pair keeps no taker margin");
                assertEq(v.makerMargin, 0, "closed pair keeps no maker margin");
            }
        }
        assertEq(longOi, sumLong, "long OI");
        assertEq(shortOi, sumShort, "short OI");
    }

    /// Every unit in the ledger is attributable: free + locked balances of known accounts plus fees and
    /// backstop equal the total.
    function invariant_everyUnitAttributed() public view {
        uint256 sum = vault.balanceOf(vault.FREE(), creator) + vault.balanceOf(vault.FREE(), maker)
            + vault.balanceOf(vault.FREE(), feeRecipient) + vault.balanceOf(vault.FREE(), trader)
            + vault.balanceOf(vault.FREE(), trader2) + vault.balanceOf(vault.FREE(), liquidator)
            + vault.balanceOf(vault.FREE(), address(handler));
        for (uint256 i; i < handler.traderCount(); ++i) {
            address t = handler.traders(i);
            sum += vault.balanceOf(vault.FREE(), t);
            Types.PairView memory v = ch.getPair(marketId, t);
            sum += v.takerMargin + v.makerMargin;
        }
        sum += vault.balanceOf(ch.commitDomain(marketId), maker);
        sum += vault.balanceOf(ch.FEES_DOMAIN(), address(0));
        sum += backstop.insuranceOf(marketId) + backstop.bondOf(marketId, creator);
        assertEq(sum, vault.totalLedger(), "unattributed ledger units");
    }

    function afterInvariant() public {
        // A run that never trades proves nothing; require the handler to have exercised fills.
        if (handler.trades() == 0) {
            emit log_named_uint("rejected trades", handler.rejectedTrades());
            emit log_named_bytes("last rejection", handler.lastTradeError());
        }
        if (handler.attempts() >= 5) assertGt(handler.trades(), 0, "no fills executed");
    }
}
