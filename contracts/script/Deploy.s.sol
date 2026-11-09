// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../src/tokens/MockERC20.sol";
import {MockPriceFeed} from "../src/oracle/MockPriceFeed.sol";
import {OracleAdapter} from "../src/oracle/OracleAdapter.sol";
import {MarginVault} from "../src/perps/MarginVault.sol";
import {ClearingHouse} from "../src/perps/ClearingHouse.sol";
import {MarketBackstop} from "../src/perps/MarketBackstop.sol";
import {PerpLens} from "../src/perps/PerpLens.sol";
import {MarketPreflight} from "../src/market/MarketPreflight.sol";
import {MarketRegistry} from "../src/market/MarketRegistry.sol";
import {SpotFactory} from "../src/spot/SpotFactory.sol";
import {SpotPool} from "../src/spot/SpotPool.sol";
import {SpotRouter} from "../src/spot/SpotRouter.sol";
import {Types} from "../src/lib/Types.sol";

/// @notice Deploys the full Rooq stack from `config/deploy/<env>.json` and `config/risk-testnet.json`.
///
/// Usage (always dry-run first, then add --broadcast):
///   DEPLOY_ENV=local DEPLOYER_PRIVATE_KEY=0x... forge script script/Deploy.s.sol --rpc-url local
///   DEPLOY_ENV=testnet DEPLOYER_PRIVATE_KEY=0x... forge script script/Deploy.s.sol --rpc-url rh_testnet
///
/// Writes `deployments/<env>.json`. Refuses to run on mainnet (4663) or on a chain id that does not
/// match the config. Mock assets and feeds carry "Mock"/"TEST" in their names.
contract Deploy is Script {
    uint256 internal constant WAD = 1e18;

    struct CollateralCfg {
        string decimals;
        string mode;
        string name;
        string symbol;
        string token;
    }

    struct MarketCfg {
        string bond;
        string decimals;
        string feedMode;
        string heartbeat;
        string key;
        string makerCommit;
        string maxOiUsdWad;
        string mode;
        string name;
        string poolFee;
        string priceUsd8;
        string seedBase;
        string seedQuote;
        string symbol;
        string tier;
        string token;
    }

    string internal constant MARKET_TYPE =
        "MarketCfg(string bond,string decimals,string feedMode,string heartbeat,string key,string makerCommit,string maxOiUsdWad,string mode,string name,string poolFee,string priceUsd8,string seedBase,string seedQuote,string symbol,string tier,string token)";
    string internal constant COLLATERAL_TYPE =
        "CollateralCfg(string decimals,string mode,string name,string symbol,string token)";

    error WrongChain(uint256 expected, uint256 actual);
    error MainnetDisabled();

    function _cfg() internal view returns (string memory env, string memory json) {
        env = vm.envString("DEPLOY_ENV");
        json = vm.readFile(string.concat(vm.projectRoot(), "/../config/deploy/", env, ".json"));
    }

    function _risk() internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../config/risk-testnet.json"));
    }

    function feedIdFor(string memory symbol) public pure returns (bytes32) {
        return keccak256(bytes(string.concat("ROOQ:", symbol, "/USD:relay-v1")));
    }

    struct Core {
        address deployer;
        address guardian;
        address feeRecipient;
        address oracleOperator;
        address collateral;
        OracleAdapter oracle;
        MarginVault vault;
        SpotFactory factory;
        SpotRouter router;
        MarketRegistry registry;
        MarketBackstop backstop;
        ClearingHouse ch;
        MarketPreflight preflight;
        PerpLens lens;
    }

    Core internal core;
    uint256 internal pk;

    function run() external {
        (string memory env, string memory json) = _cfg();
        if (block.chainid == 4663) revert MainnetDisabled();
        uint256 expected = vm.parseJsonUint(json, ".chainId");
        if (block.chainid != expected) revert WrongChain(expected, block.chainid);

        pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        core.deployer = vm.addr(pk);
        core.guardian = vm.envOr("GUARDIAN", core.deployer);
        core.feeRecipient = vm.envOr("FEE_RECIPIENT", core.deployer);
        core.oracleOperator = vm.envOr("ORACLE_OPERATOR", core.deployer);

        // A dry run writes to <env>.dryrun.json so simulated addresses can never be mistaken for a deployment.
        bool broadcasting = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        string memory name = broadcasting ? env : string.concat(env, ".dryrun");
        _deployCore(json);
        _writeCore(env, name);
        MarketCfg[] memory markets = abi.decode(vm.parseJsonTypeArray(json, ".markets", MARKET_TYPE), (MarketCfg[]));
        string memory marketsJson = _deployMarkets(markets);
        vm.writeFile(string.concat(vm.projectRoot(), "/deployments/", name, ".markets.json"), marketsJson);
        console2.log("Deployment written to deployments/%s.json and .markets.json", name);
    }

    function _deployCore(string memory json) internal {
        CollateralCfg memory cc = abi.decode(vm.parseJsonType(json, ".collateral", COLLATERAL_TYPE), (CollateralCfg));
        vm.startBroadcast(pk);
        core.collateral = _eq(cc.mode, "mock")
            ? address(new MockERC20(cc.name, cc.symbol, uint8(vm.parseUint(cc.decimals)), 100_000e6))
            : vm.parseAddress(cc.token);
        core.oracle = new OracleAdapter(core.deployer, address(0), 0);
        core.vault = new MarginVault(core.collateral, core.deployer);
        core.factory = new SpotFactory(core.guardian);
        core.router = new SpotRouter(address(core.factory));
        core.registry = new MarketRegistry(
            core.deployer, core.guardian, address(core.vault), address(core.factory), address(core.oracle), _bounds()
        );
        core.backstop = new MarketBackstop(address(core.vault), address(core.registry), core.deployer);
        core.ch = new ClearingHouse(
            address(core.vault), address(core.registry), address(core.oracle), address(core.backstop), core.feeRecipient
        );
        core.preflight = new MarketPreflight(
            address(core.registry), address(core.oracle), address(core.ch), address(core.backstop)
        );
        core.lens = new PerpLens(address(core.ch), address(core.registry), address(core.oracle));
        core.vault.wireOperators(address(core.ch), address(core.backstop));
        core.backstop.wireClearingHouse(address(core.ch));
        core.registry.wire(address(core.ch), address(core.preflight));
        _setTiers(core.registry);
        core.registry.setQuoteAsset(core.collateral, true);
        vm.stopBroadcast();
    }

    function _writeCore(string memory env, string memory name) internal {
        string memory out = "deployment";
        vm.serializeString(out, "env", env);
        vm.serializeUint(out, "chainId", block.chainid);
        vm.serializeAddress(out, "deployer", core.deployer);
        vm.serializeAddress(out, "guardian", core.guardian);
        vm.serializeAddress(out, "feeRecipient", core.feeRecipient);
        vm.serializeAddress(out, "oracleOperator", core.oracleOperator);
        vm.serializeAddress(out, "collateral", core.collateral);
        vm.serializeAddress(out, "oracleAdapter", address(core.oracle));
        vm.serializeAddress(out, "marginVault", address(core.vault));
        vm.serializeAddress(out, "spotFactory", address(core.factory));
        vm.serializeAddress(out, "spotRouter", address(core.router));
        vm.serializeAddress(out, "marketRegistry", address(core.registry));
        vm.serializeAddress(out, "marketBackstop", address(core.backstop));
        vm.serializeAddress(out, "clearingHouse", address(core.ch));
        vm.serializeAddress(out, "marketPreflight", address(core.preflight));
        vm.serializeAddress(out, "perpLens", address(core.lens));
        vm.serializeUint(out, "deployBlock", block.number);
        string memory doc = vm.serializeUint(out, "deployTimestamp", block.timestamp);
        vm.writeJson(doc, string.concat(vm.projectRoot(), "/deployments/", name, ".json"));
    }

    function _deployMarkets(MarketCfg[] memory markets) internal returns (string memory list) {
        list = "[";
        for (uint256 i; i < markets.length; ++i) {
            string memory one = _deployMarket(markets[i]);
            list = string.concat(list, i == 0 ? "" : ",", one);
        }
        list = string.concat(list, "]");
    }

    function _deployMarket(MarketCfg memory m) internal returns (string memory) {
        vm.startBroadcast(pk);
        address base = _eq(m.mode, "mock")
            ? address(new MockERC20(m.name, m.symbol, uint8(vm.parseUint(m.decimals)), 1_000e18))
            : vm.parseAddress(m.token);
        address feed;
        bytes32 feedId;
        if (_eq(m.feedMode, "relay")) {
            feed = address(new MockPriceFeed(8, string.concat("TEST relay ", m.symbol, " / USD"), core.oracleOperator));
            if (core.oracleOperator == core.deployer) MockPriceFeed(feed).setAnswer(int256(vm.parseUint(m.priceUsd8)));
            feedId = feedIdFor(m.symbol);
            core.oracle.registerFeed(feedId, feed, base, uint32(vm.parseUint(m.heartbeat)), 1e14, 1e25);
        }
        bytes32 marketId = core.registry.createMarket(base, core.collateral, uint16(vm.parseUint(m.poolFee)));
        if (feed != address(0)) {
            core.registry.proposePerp(marketId, uint16(vm.parseUint(m.tier)), feedId, vm.parseUint(m.maxOiUsdWad));
        }
        vm.stopBroadcast();

        string memory k = string.concat("market-", m.key);
        vm.serializeAddress(k, "base", base);
        vm.serializeAddress(k, "pool", core.registry.getMarket(marketId).pool);
        vm.serializeAddress(k, "feed", feed);
        vm.serializeBytes32(k, "feedId", feedId);
        return vm.serializeBytes32(k, "marketId", marketId);
    }

    function _bounds() internal view returns (Types.GlobalBounds memory b) {
        string memory r = _risk();
        b.minImrWad = vm.parseUint(vm.parseJsonString(r, ".globalBounds.minImrWad"));
        b.minMmrWad = vm.parseUint(vm.parseJsonString(r, ".globalBounds.minMmrWad"));
        b.maxOiUsdWad = vm.parseUint(vm.parseJsonString(r, ".globalBounds.maxOiUsdWad"));
        b.maxTakerFeeBps = uint16(vm.parseJsonUint(r, ".globalBounds.maxTakerFeeBps"));
        b.maxLiqPenaltyBps = uint16(vm.parseJsonUint(r, ".globalBounds.maxLiqPenaltyBps"));
        b.maxDeviationBps = uint16(vm.parseJsonUint(r, ".globalBounds.maxDeviationBps"));
        b.maxFundingRatePerHourWad = vm.parseUint(vm.parseJsonString(r, ".globalBounds.maxFundingRatePerHourWad"));
    }

    function _setTiers(MarketRegistry registry) internal {
        string memory r = _risk();
        for (uint256 i; i < 4; ++i) {
            string memory p = string.concat(".tiers[", vm.toString(i), "]");
            Types.RiskParams memory t;
            t.imrWad = vm.parseUint(vm.parseJsonString(r, string.concat(p, ".imrWad")));
            t.mmrWad = vm.parseUint(vm.parseJsonString(r, string.concat(p, ".mmrWad")));
            t.maxOiUsdWad = vm.parseUint(vm.parseJsonString(r, string.concat(p, ".maxOiUsdWad")));
            t.takerFeeBps = uint16(vm.parseJsonUint(r, string.concat(p, ".takerFeeBps")));
            t.makerFeeBps = uint16(vm.parseJsonUint(r, string.concat(p, ".makerFeeBps")));
            t.liqPenaltyBps = uint16(vm.parseJsonUint(r, string.concat(p, ".liqPenaltyBps")));
            t.maxDeviationBps = uint16(vm.parseJsonUint(r, string.concat(p, ".maxDeviationBps")));
            t.maxFundingRatePerHourWad =
                vm.parseUint(vm.parseJsonString(r, string.concat(p, ".maxFundingRatePerHourWad")));
            t.minMakerBacking = vm.parseUint(vm.parseJsonString(r, string.concat(p, ".minMakerBacking")));
            t.minBond = vm.parseUint(vm.parseJsonString(r, string.concat(p, ".minBond")));
            t.version = uint32(vm.parseJsonUint(r, string.concat(p, ".version")));
            registry.setTier(uint16(vm.parseJsonUint(r, string.concat(p, ".id"))), t);
        }
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
