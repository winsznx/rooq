// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../../src/tokens/MockERC20.sol";
import {MockPriceFeed} from "../../src/oracle/MockPriceFeed.sol";
import {OracleAdapter} from "../../src/oracle/OracleAdapter.sol";
import {MarginVault} from "../../src/perps/MarginVault.sol";
import {ClearingHouse} from "../../src/perps/ClearingHouse.sol";
import {MarketBackstop} from "../../src/perps/MarketBackstop.sol";
import {PerpLens} from "../../src/perps/PerpLens.sol";
import {MarketPreflight} from "../../src/market/MarketPreflight.sol";
import {MarketRegistry} from "../../src/market/MarketRegistry.sol";
import {SpotFactory} from "../../src/spot/SpotFactory.sol";
import {SpotPool} from "../../src/spot/SpotPool.sol";
import {SpotRouter} from "../../src/spot/SpotRouter.sol";
import {Types} from "../../src/lib/Types.sol";

/// @notice Shared deployment used by every financial test. Mirrors script/Deploy.s.sol wiring.
abstract contract Fixture is Test {
    uint256 internal constant WAD = 1e18;
    bytes32 internal constant FEED_ID = keccak256("TEST:mBTC/USD");
    uint16 internal constant TIER_B = 2;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");
    address internal trader2 = makeAddr("trader2");
    address internal liquidator = makeAddr("liquidator");
    address internal feeRecipient = makeAddr("feeRecipient");
    uint256 internal makerKey = 0xA11CE;
    address internal maker;

    MockERC20 internal usd;
    MockERC20 internal btc;
    MockPriceFeed internal feed;
    OracleAdapter internal oracle;
    MarginVault internal vault;
    SpotFactory internal factory;
    SpotRouter internal router;
    MarketRegistry internal registry;
    MarketBackstop internal backstop;
    ClearingHouse internal ch;
    MarketPreflight internal preflight;
    PerpLens internal lens;
    bytes32 internal marketId;
    SpotPool internal pool;

    uint256 internal constant BTC_PRICE = 60_000; // whole USD
    uint256 internal constant MIN_BACKING = 50_000e6;
    uint256 internal constant MIN_BOND = 1_000e6;

    function setUp() public virtual {
        maker = vm.addr(makerKey);
        vm.warp(1_800_000_000);

        usd = new MockERC20("Mock USD (Test collateral)", "mUSD", 6, 1_000_000e6);
        btc = new MockERC20("Mock BTC (Test asset)", "mBTC", 18, 10e18);
        feed = new MockPriceFeed(8, "TEST mBTC / USD", admin);
        vm.prank(admin);
        feed.setAnswer(int256(BTC_PRICE * 1e8));

        oracle = new OracleAdapter(admin, address(0), 0);
        vm.prank(admin);
        oracle.registerFeed(FEED_ID, address(feed), address(btc), 3600, 1e18, 1e30);

        vault = new MarginVault(address(usd), address(this));
        factory = new SpotFactory(guardian);
        router = new SpotRouter(address(factory));
        registry = new MarketRegistry(admin, guardian, address(vault), address(factory), address(oracle), _globalBounds());
        backstop = new MarketBackstop(address(vault), address(registry), address(this));
        ch = new ClearingHouse(address(vault), address(registry), address(oracle), address(backstop), feeRecipient);
        preflight = new MarketPreflight(address(registry), address(oracle), address(ch), address(backstop));
        lens = new PerpLens(address(ch), address(registry), address(oracle));

        vault.wireOperators(address(ch), address(backstop));
        backstop.wireClearingHouse(address(ch));
        vm.startPrank(admin);
        registry.wire(address(ch), address(preflight));
        registry.setTier(TIER_B, _tierB());
        registry.setQuoteAsset(address(usd), true);
        vm.stopPrank();

        _fund(creator, 200_000e6);
        _fund(maker, 500_000e6);
        _fund(trader, 100_000e6);
        _fund(trader2, 100_000e6);
        _fund(liquidator, 1_000e6);
        btc.mintTo(creator, 10e18);

        vm.startPrank(creator);
        marketId = registry.createMarket(address(btc), address(usd), 25);
        pool = SpotPool(registry.getMarket(marketId).pool);
        btc.approve(address(pool), type(uint256).max);
        usd.approve(address(pool), type(uint256).max);
        _seed(pool, address(btc), 2e18, 120_000e6, creator);
        registry.proposePerp(marketId, TIER_B, FEED_ID, 1_000_000e18);
        usd.approve(address(vault), type(uint256).max);
        vault.deposit(MIN_BOND, creator);
        backstop.postBond(marketId, MIN_BOND);
        vm.stopPrank();

        _deposit(maker, 400_000e6);
        vm.prank(maker);
        ch.commitBacking(marketId, 300_000e6);

        preflight.activatePerps(marketId);
    }

    /// @dev Adds liquidity with amounts ordered by the pool's sorted token0/token1, whatever the addresses.
    function _seed(SpotPool p, address base, uint256 baseAmount, uint256 quoteAmount, address to)
        internal
        returns (uint256 shares)
    {
        (uint256 a0, uint256 a1) = p.token0() == base ? (baseAmount, quoteAmount) : (quoteAmount, baseAmount);
        (,, shares) = p.addLiquidity(a0, a1, 0, 0, to, uint64(vm.getBlockTimestamp() + 60));
    }

    function _globalBounds() internal pure returns (Types.GlobalBounds memory b) {
        b.minImrWad = 0.3e18;
        b.minMmrWad = 0.15e18;
        b.maxOiUsdWad = 10_000_000e18;
        b.maxTakerFeeBps = 100;
        b.maxLiqPenaltyBps = 500;
        b.maxDeviationBps = 500;
        b.maxFundingRatePerHourWad = 0.001e18;
    }

    function _tierB() internal pure returns (Types.RiskParams memory p) {
        p.imrWad = 0.5e18;
        p.mmrWad = 0.35e18;
        p.maxOiUsdWad = 2_000_000e18;
        p.takerFeeBps = 6;
        p.makerFeeBps = 0;
        p.liqPenaltyBps = 100;
        p.maxDeviationBps = 200;
        p.maxFundingRatePerHourWad = 0.0001e18;
        p.minMakerBacking = MIN_BACKING;
        p.minBond = MIN_BOND;
        p.version = 1;
    }

    function _fund(address who, uint256 amount) internal {
        usd.mintTo(who, amount);
    }

    function _deposit(address who, uint256 amount) internal {
        vm.startPrank(who);
        usd.approve(address(vault), type(uint256).max);
        vault.deposit(amount, who);
        vm.stopPrank();
    }

    function _quote(address taker, int256 size, uint256 priceWad, uint256 nonce)
        internal
        view
        returns (Types.Quote memory q)
    {
        q = Types.Quote({
            marketId: marketId,
            maker: maker,
            taker: taker,
            size: size,
            price: priceWad,
            minFill: 0,
            nonce: nonce,
            deadline: uint64(vm.getBlockTimestamp() + 30),
            policyVersion: 1
        });
    }

    function _sign(Types.Quote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, ch.hashQuote(q));
        return abi.encodePacked(r, s, v);
    }

    function _params(int256 fill, uint256 margin, uint256 limitPrice) internal view returns (Types.TradeParams memory) {
        return Types.TradeParams({
            fillSize: fill,
            marginDeposit: margin,
            limitPrice: limitPrice,
            maxFeeBps: 10,
            deadline: uint64(vm.getBlockTimestamp() + 30)
        });
    }

    /// Opens a taker position at the oracle price with the given margin.
    function _open(address taker, int256 size, uint256 margin, uint256 nonce) internal {
        uint256 px = BTC_PRICE * WAD;
        Types.Quote memory q = _quote(taker, size, px, nonce);
        bytes memory sig = _sign(q);
        uint256 limit = size > 0 ? px : 0;
        vm.prank(taker);
        ch.trade(q, sig, _params(size, margin, limit));
    }

    function _setPrice(uint256 usdPrice) internal {
        vm.prank(admin);
        feed.setAnswer(int256(usdPrice * 1e8));
    }

    /// Sum of every ledger domain must never exceed what the vault actually holds.
    function _assertConservation() internal view {
        assertEq(vault.totalLedger(), usd.balanceOf(address(vault)), "ledger != token balance");
    }
}
