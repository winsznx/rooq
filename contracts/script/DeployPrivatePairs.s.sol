// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MockERC20} from "../src/tokens/MockERC20.sol";
import {MockPriceFeed} from "../src/oracle/MockPriceFeed.sol";
import {OracleAdapter} from "../src/oracle/OracleAdapter.sol";
import {AppendVerifier} from "../src/privacy/verifiers/AppendVerifier.sol";
import {SpendVerifier} from "../src/privacy/verifiers/SpendVerifier.sol";
import {LockVerifier} from "../src/privacy/verifiers/LockVerifier.sol";
import {OpenPairVerifier} from "../src/privacy/verifiers/OpenPairVerifier.sol";
import {LiquidateVerifier} from "../src/privacy/verifiers/LiquidateVerifier.sol";
import {ReleaseVerifier} from "../src/privacy/verifiers/ReleaseVerifier.sol";
import {FundingEpochVerifier} from "../src/privacy/verifiers/FundingEpochVerifier.sol";
import {ClosePairVerifier} from "../src/privacy/verifiers/ClosePairVerifier.sol";
import {ExitRequestVerifier} from "../src/privacy/verifiers/ExitRequestVerifier.sol";
import {PairUpdateVerifier} from "../src/privacy/verifiers/PairUpdateVerifier.sol";
import {RedeemClaimVerifier} from "../src/privacy/verifiers/RedeemClaimVerifier.sol";
import {InsuranceSweepVerifier} from "../src/privacy/verifiers/InsuranceSweepVerifier.sol";
import {SwapVerifier} from "../src/privacy/verifiers/SwapVerifier.sol";
import {LpAddVerifier} from "../src/privacy/verifiers/LpAddVerifier.sol";
import {LpSetVerifier} from "../src/privacy/verifiers/LpSetVerifier.sol";
import {LpRemoveVerifier} from "../src/privacy/verifiers/LpRemoveVerifier.sol";
import {IHonkVerifier} from "../src/privacy/ShieldedPool.sol";
import {IPriceSource, PrivatePairs} from "../src/privacy/PrivatePairs.sol";
import {PairTypes} from "../src/privacy/PairTypes.sol";
import {PrivateSpot} from "../src/privacy/PrivateSpot.sol";
import {PrivateMarkets} from "../src/privacy/PrivateMarkets.sol";
import {BondReleaseVerifier} from "../src/privacy/verifiers/BondReleaseVerifier.sol";

/// Deploys the private candidate. Keys come from the environment as Grumpkin public coordinates: COORDINATOR_X/Y,
/// RISK_A_X/Y, RISK_B_X/Y, and FEE_AUTH with FEE_X/Y for the fee address. KEY_GUARDIAN may name the address allowed to
/// rotate those keys (D-24); without it the deployer holds that role, which is disclosed for testnet.
///   local (31337):   deploys labelled test tokens.
///   testnet (46630): PRIVACY_ASSET is the canonical collateral and PRIVACY_SPOT_TOKENS the tokens with a pool against it.
///                    PRIVACY_PERP_TOKENS, PRIVACY_PERP_SYMBOLS and PRIVACY_PERP_PRICES_8 list one perps market each, on tier B
///                    of config/risk-testnet.json. Each has its own single-operator TEST relay feed (blocker 2 in
///                    IMPLEMENTATION_STATUS.md), handed to PRIVACY_RELAY_OPERATOR after its start price is written.
contract DeployPrivatePairs is Script {
    uint256 internal constant MARKET_ID = 1;
    uint256 internal constant OTHER_MARKET_ID = 2;
    uint256 internal constant SPOT_FEE_BPS = 30;
    /// @dev Tier B in config/risk-testnet.json. Checked by name when it is read.
    uint256 internal constant TESTNET_PERP_TIER = 1;

    bool internal local;
    address internal deployer;
    address internal asset;
    address[] internal spotTokens;
    OracleAdapter internal oracle;
    MockPriceFeed internal feed;
    MockPriceFeed internal otherFeed;
    IHonkVerifier internal appendV;
    IHonkVerifier internal spendV;
    PairTypes.Verifiers internal pairVerifiers;
    PairTypes.MarketConfig[] internal marketConfigs;
    address internal spotAddress;
    address internal marketsAddress;
    IHonkVerifier internal bondVerifier;
    IHonkVerifier internal redeemV;
    IHonkVerifier internal sweepV;
    MockPriceFeed internal thirdFeed;
    bytes32 internal thirdFeedId;
    string[] internal perpSymbols;
    address[] internal perpTokens;
    address[] internal perpFeeds;
    bytes32[] internal perpFeedIds;
    uint256[] internal perpMarketIds;
    address internal relayOperator;

    function run() external {
        require(block.chainid == 31337 || block.chainid == 46630, "unsupported chain");
        local = block.chainid == 31337;
        deployer = vm.addr(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        _tokens();
        _markets();
        PrivateSpot.Verifiers memory spotVerifiers = _spotVerifiers();
        PrivatePairs pool = _deployCustody();
        PrivateSpot spot = new PrivateSpot(pool, spotVerifiers, _pools());
        require(address(spot) == pool.spotModule(), "spot address prediction failed");
        PrivateMarkets marketsModule = new PrivateMarkets(pool, bondVerifier, redeemV, sweepV, asset, _tiers(), vm.envOr("KEY_GUARDIAN", deployer));
        require(address(marketsModule) == pool.marketsModule(), "markets address prediction failed");
        vm.stopBroadcast();
        _writeOutput(pool, spot, marketsModule);
        console2.log("PrivatePairs", address(pool));
        console2.log("PrivateSpot", address(spot));
    }

    function _tokens() internal {
        if (local) {
            asset = address(new MockERC20("Test USDG (local fixture)", "tUSDG", 6, 1_000_000e6));
            spotTokens.push(address(new MockERC20("Test Stock A (local fixture)", "tSTKA", 18, type(uint128).max)));
            spotTokens.push(address(new MockERC20("Test Stock B (local fixture)", "tSTKB", 18, type(uint128).max)));
        } else {
            asset = vm.envAddress("PRIVACY_ASSET");
            address[] memory t = vm.envAddress("PRIVACY_SPOT_TOKENS", ",");
            for (uint256 i; i < t.length; i++) spotTokens.push(t[i]);
        }
    }

    function _markets() internal {
        if (local) _localMarkets();
        else _testnetMarkets();
    }

    function _localMarkets() internal {
        address base = asset;
        int256 start = int256(250e8);
        feed = new MockPriceFeed(8, "TEST relay / USD", deployer);
        feed.setAnswer(start);
        otherFeed = new MockPriceFeed(8, "TEST relay second market / USD", deployer);
        otherFeed.setAnswer(int256(218e8));
        oracle = new OracleAdapter(deployer, address(0), 0);
        bytes32 feedId = keccak256("ROOQ:private-v1:TEST/USD");
        bytes32 otherFeedId = keccak256("OTHER/USD");
        oracle.registerFeed(feedId, address(feed), base, 7 days, 1e18, 100_000e18);
        oracle.registerFeed(otherFeedId, address(otherFeed), base, 7 days, 1e18, 100_000e18);
        thirdFeed = new MockPriceFeed(8, "TEST relay creatable market / USD", deployer);
        thirdFeed.setAnswer(int256(100e8));
        thirdFeedId = keccak256("ROOQ:private-v1:CREATABLE/USD");
        oracle.registerFeed(thirdFeedId, address(thirdFeed), base, 7 days, 1e18, 100_000e18);
        marketConfigs.push(PairTypes.MarketConfig(MARKET_ID, asset, feedId, 0.1e18, 0.05e18, 100, 0.05e18, 0, 1_000_000_000e18, 100e18));
        marketConfigs.push(PairTypes.MarketConfig(OTHER_MARKET_ID, asset, otherFeedId, 0.1e18, 0.05e18, 100, 0.05e18, 10, 1_000_000_000e18, 100e18));
    }

    function _testnetMarkets() internal {
        relayOperator = vm.envAddress("PRIVACY_RELAY_OPERATOR");
        address[] memory tokens = vm.envAddress("PRIVACY_PERP_TOKENS", ",");
        string[] memory symbols = vm.envString("PRIVACY_PERP_SYMBOLS", ",");
        uint256[] memory prices = vm.envUint("PRIVACY_PERP_PRICES_8", ",");
        require(tokens.length == symbols.length && tokens.length == prices.length && tokens.length >= 2, "perp market lists differ");
        string memory risk = _riskConfig();
        require(keccak256(bytes(vm.parseJsonString(risk, string.concat(_tierPath(TESTNET_PERP_TIER), ".name")))) == keccak256("B"), "tier index is not B");
        PrivateMarkets.Tier memory tier = _tierAt(risk, TESTNET_PERP_TIER);
        _requireWithinGlobalBounds(risk, tier);
        oracle = new OracleAdapter(deployer, address(0), 0);
        for (uint256 i; i < tokens.length; i++) {
            bytes32 feedId = keccak256(bytes(string.concat("ROOQ:private-v1:", symbols[i], "/USD")));
            MockPriceFeed f = _testnetFeed(string.concat("TEST relay ", symbols[i], " / USD"), prices[i], feedId, tokens[i]);
            perpSymbols.push(symbols[i]);
            perpTokens.push(tokens[i]);
            perpFeeds.push(address(f));
            perpFeedIds.push(feedId);
            perpMarketIds.push(i + 1);
            marketConfigs.push(PairTypes.MarketConfig(i + 1, asset, feedId, tier.imrWad, tier.mmrWad, tier.penaltyBps, tier.maxFundingPerHourWad, tier.takerFeeBps, tier.maxOiUsdWad, tier.maxPairSize));
        }
        feed = MockPriceFeed(perpFeeds[0]);
        otherFeed = MockPriceFeed(perpFeeds[1]);
        thirdFeedId = keccak256("ROOQ:private-v1:CREATABLE/USD");
        thirdFeed = _testnetFeed("TEST relay creatable market / USD", prices[0], thirdFeedId, tokens[0]);
    }

    /// @dev Registered while the deployer still operates it, then handed to the relay, so the deployer key can stay off the server.
    function _testnetFeed(string memory description, uint256 price8, bytes32 feedId, address base) internal returns (MockPriceFeed f) {
        f = new MockPriceFeed(8, description, deployer);
        f.setAnswer(int256(price8));
        oracle.registerFeed(feedId, address(f), base, 7 days, 1e18, 100_000e18);
        f.transferOperator(relayOperator);
    }

    function _pairVerifiers() internal returns (PairTypes.Verifiers memory) {
        return PairTypes.Verifiers(
            IHonkVerifier(address(new LockVerifier())),
            IHonkVerifier(address(new OpenPairVerifier())),
            IHonkVerifier(address(new LiquidateVerifier())),
            IHonkVerifier(address(new ReleaseVerifier())),
            IHonkVerifier(address(new FundingEpochVerifier())),
            IHonkVerifier(address(new ClosePairVerifier())),
            IHonkVerifier(address(new ExitRequestVerifier())),
            IHonkVerifier(address(new PairUpdateVerifier()))
        );
    }

    function _spotVerifiers() internal returns (PrivateSpot.Verifiers memory) {
        return PrivateSpot.Verifiers(
            IHonkVerifier(address(new SwapVerifier())),
            IHonkVerifier(address(new LpAddVerifier())),
            IHonkVerifier(address(new LpSetVerifier())),
            IHonkVerifier(address(new LpRemoveVerifier()))
        );
    }

    function _deployCustody() internal returns (PrivatePairs) {
        appendV = IHonkVerifier(address(new AppendVerifier()));
        spendV = IHonkVerifier(address(new SpendVerifier()));
        pairVerifiers = _pairVerifiers();
        bondVerifier = IHonkVerifier(address(new BondReleaseVerifier()));
        redeemV = IHonkVerifier(address(new RedeemClaimVerifier()));
        sweepV = IHonkVerifier(address(new InsuranceSweepVerifier()));
        // PrivateSpot and PrivateMarkets are created right after this contract, so their addresses can be fixed immutably here.
        spotAddress = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        marketsAddress = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 2);
        return new PrivatePairs(
            appendV, spendV, _assets(), pairVerifiers, IPriceSource(address(oracle)), _point("COORDINATOR"), _risk(), _feeTo(), marketConfigs, PairTypes.Modules(spotAddress, marketsAddress)
        );
    }

    function _assets() internal view returns (address[] memory assets) {
        assets = new address[](spotTokens.length + 1);
        assets[0] = asset;
        for (uint256 i; i < spotTokens.length; i++) assets[i + 1] = spotTokens[i];
    }

    function _risk() internal view returns (PairTypes.Point[2] memory) {
        return [_point("RISK_A"), _point("RISK_B")];
    }

    function _feeTo() internal view returns (PairTypes.FeeRecipient memory) {
        return PairTypes.FeeRecipient(vm.envUint("FEE_AUTH"), PairTypes.Point(vm.envUint("FEE_X"), vm.envUint("FEE_Y")));
    }

    /// @dev Testnet risk tiers come from config/risk-testnet.json; local tests use one fixed tier.
    function _tiers() internal view returns (PrivateMarkets.Tier[] memory tiers) {
        if (local) {
            tiers = new PrivateMarkets.Tier[](1);
            tiers[0] = PrivateMarkets.Tier(0.1e18, 0.05e18, 1_000_000_000e18, 0, 100, 0.05e18, 100e18, 10e6);
            return tiers;
        }
        string memory json = _riskConfig();
        uint256 count = vm.envUint("PRIVACY_TIER_COUNT");
        tiers = new PrivateMarkets.Tier[](count);
        for (uint256 i; i < count; i++) tiers[i] = _tierAt(json, i);
    }

    function _riskConfig() internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../config/risk-testnet.json"));
    }

    function _tierPath(uint256 i) internal view returns (string memory) {
        return string.concat(".tiers[", vm.toString(i), "]");
    }

    function _tierAt(string memory json, uint256 i) internal view returns (PrivateMarkets.Tier memory) {
        string memory k = _tierPath(i);
        return PrivateMarkets.Tier(
            vm.parseJsonUint(json, string.concat(k, ".imrWad")),
            vm.parseJsonUint(json, string.concat(k, ".mmrWad")),
            vm.parseJsonUint(json, string.concat(k, ".maxOiUsdWad")),
            vm.parseJsonUint(json, string.concat(k, ".takerFeeBps")),
            vm.parseJsonUint(json, string.concat(k, ".liqPenaltyBps")),
            vm.parseJsonUint(json, string.concat(k, ".maxFundingRatePerHourWad")),
            100e18,
            vm.parseJsonUint(json, string.concat(k, ".minBond"))
        );
    }

    function _requireWithinGlobalBounds(string memory json, PrivateMarkets.Tier memory t) internal pure {
        require(t.imrWad >= vm.parseJsonUint(json, ".globalBounds.minImrWad"), "IMR below global bound");
        require(t.mmrWad >= vm.parseJsonUint(json, ".globalBounds.minMmrWad"), "MMR below global bound");
        require(t.maxOiUsdWad <= vm.parseJsonUint(json, ".globalBounds.maxOiUsdWad"), "OI above global bound");
        require(t.takerFeeBps <= vm.parseJsonUint(json, ".globalBounds.maxTakerFeeBps"), "fee above global bound");
        require(t.penaltyBps <= vm.parseJsonUint(json, ".globalBounds.maxLiqPenaltyBps"), "penalty above global bound");
        require(t.maxFundingPerHourWad <= vm.parseJsonUint(json, ".globalBounds.maxFundingRatePerHourWad"), "funding above global bound");
    }

    function _point(string memory name) internal view returns (PairTypes.Point memory) {
        return PairTypes.Point(vm.envUint(string.concat(name, "_X")), vm.envUint(string.concat(name, "_Y")));
    }

    function _pools() internal view returns (PrivateSpot.PoolConfig[] memory pools) {
        pools = new PrivateSpot.PoolConfig[](spotTokens.length);
        for (uint256 i; i < spotTokens.length; i++) {
            // Pool i + 1 pairs the collateral with token i. Locally the last pool links the two fixtures, for routed swaps.
            bool link = local && i == spotTokens.length - 1;
            pools[i] = PrivateSpot.PoolConfig(i + 1, link ? spotTokens[0] : asset, spotTokens[i], SPOT_FEE_BPS);
        }
    }

    /// @dev What the relay, the launcher and the web app's NEXT_PUBLIC_PRIVATE_MARKET_MAP and _POOL_MAP are built from.
    function _serializeTestnet(string memory o) internal {
        vm.serializeAddress(o, "relayOperator", relayOperator);
        vm.serializeString(o, "perpSymbols", perpSymbols);
        vm.serializeAddress(o, "perpTokens", perpTokens);
        vm.serializeAddress(o, "perpFeeds", perpFeeds);
        vm.serializeBytes32(o, "perpFeedIds", perpFeedIds);
        vm.serializeUint(o, "perpMarketIds", perpMarketIds);
        vm.serializeString(o, "marketMap", _keyMap(false));
        vm.serializeString(o, "poolMap", _keyMap(true));
    }

    /// @dev Key:id pairs. Pool i + 1 pairs the collateral with spot token i, so a pool id is found by token, never by position.
    function _keyMap(bool pools) internal view returns (string memory map) {
        for (uint256 i; i < perpSymbols.length; i++) {
            uint256 id = pools ? _poolOf(perpTokens[i]) : perpMarketIds[i];
            map = string.concat(map, i == 0 ? "" : ",", perpSymbols[i], ":", vm.toString(id));
        }
    }

    function _poolOf(address token) internal view returns (uint256) {
        for (uint256 i; i < spotTokens.length; i++) if (spotTokens[i] == token) return i + 1;
        revert("perp token has no spot pool");
    }

    function _writeOutput(PrivatePairs pool, PrivateSpot spot, PrivateMarkets marketsModule) internal {
        string memory o = "pairs";
        vm.serializeString(o, "status", "Testnet. TEST oracle relay. Not audited.");
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "startBlock", block.number);
        vm.serializeUint(o, "deploymentId", pool.deploymentId());
        vm.serializeUint(o, "market", MARKET_ID);
        vm.serializeAddress(o, "asset", asset);
        vm.serializeAddress(o, "feed", address(feed));
        vm.serializeAddress(o, "otherFeed", address(otherFeed));
        vm.serializeAddress(o, "oracle", address(oracle));
        vm.serializeAddress(o, "spot", address(spot));
        vm.serializeAddress(o, "markets", address(marketsModule));
        vm.serializeAddress(o, "keyGuardian", marketsModule.keyGuardian());
        vm.serializeAddress(o, "thirdFeed", address(thirdFeed));
        vm.serializeBytes32(o, "thirdFeedId", thirdFeedId);
        vm.serializeAddress(o, "spotTokens", spotTokens);
        if (!local) _serializeTestnet(o);
        string memory json = vm.serializeAddress(o, "pool", address(pool));
        vm.writeJson(json, vm.envString("PRIVACY_OUT"));
    }
}
