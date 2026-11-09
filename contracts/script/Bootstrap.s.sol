// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../src/tokens/MockERC20.sol";
import {MarginVault} from "../src/perps/MarginVault.sol";
import {ClearingHouse} from "../src/perps/ClearingHouse.sol";
import {MarketBackstop} from "../src/perps/MarketBackstop.sol";
import {MarketPreflight} from "../src/market/MarketPreflight.sol";
import {MarketRegistry} from "../src/market/MarketRegistry.sol";
import {SpotPool} from "../src/spot/SpotPool.sol";
import {Types} from "../src/lib/Types.sol";

/// @notice Funds what `Deploy` registered: seeds each spot pool, posts the creator bond, commits maker
///         backing and activates perps through MarketPreflight when every onchain check passes.
///         Any step without enough real balance is skipped and logged; nothing is faked.
///
///   DEPLOY_ENV=testnet DEPLOYER_PRIVATE_KEY=0x.. MAKER_PRIVATE_KEY=0x.. \
///     forge script script/Bootstrap.s.sol --rpc-url rh_testnet [--broadcast]
contract Bootstrap is Script {
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

    struct Deployed {
        address base;
        address feed;
        bytes32 feedId;
        bytes32 marketId;
        address pool;
    }

    struct Ctx {
        uint256 creatorKey;
        uint256 makerKey;
        address creator;
        address maker;
        address collateral;
        bool collateralIsMock;
        MarginVault vault;
        ClearingHouse ch;
        MarketBackstop backstop;
        MarketPreflight preflight;
        MarketRegistry registry;
    }

    string internal constant MARKET_TYPE =
        "MarketCfg(string bond,string decimals,string feedMode,string heartbeat,string key,string makerCommit,string maxOiUsdWad,string mode,string name,string poolFee,string priceUsd8,string seedBase,string seedQuote,string symbol,string tier,string token)";
    string internal constant DEPLOYED_TYPE =
        "Deployed(address base,address feed,bytes32 feedId,bytes32 marketId,address pool)";

    function run() external {
        string memory env = vm.envString("DEPLOY_ENV");
        string memory root = vm.projectRoot();
        string memory cfg = vm.readFile(string.concat(root, "/../config/deploy/", env, ".json"));
        string memory dep = vm.readFile(string.concat(root, "/deployments/", env, ".json"));
        string memory depMarkets = vm.readFile(string.concat(root, "/deployments/", env, ".markets.json"));

        Ctx memory c;
        c.creatorKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        c.makerKey = vm.envUint("MAKER_PRIVATE_KEY");
        c.creator = vm.addr(c.creatorKey);
        c.maker = vm.addr(c.makerKey);
        c.collateral = vm.parseJsonAddress(dep, ".collateral");
        c.collateralIsMock = keccak256(bytes(vm.parseJsonString(cfg, ".collateral.mode"))) == keccak256("mock");
        c.vault = MarginVault(vm.parseJsonAddress(dep, ".marginVault"));
        c.ch = ClearingHouse(vm.parseJsonAddress(dep, ".clearingHouse"));
        c.backstop = MarketBackstop(vm.parseJsonAddress(dep, ".marketBackstop"));
        c.preflight = MarketPreflight(vm.parseJsonAddress(dep, ".marketPreflight"));
        c.registry = MarketRegistry(vm.parseJsonAddress(dep, ".marketRegistry"));

        MarketCfg[] memory ms = abi.decode(vm.parseJsonTypeArray(cfg, ".markets", MARKET_TYPE), (MarketCfg[]));
        Deployed[] memory ds = abi.decode(vm.parseJsonTypeArray(depMarkets, "$", DEPLOYED_TYPE), (Deployed[]));
        require(ms.length == ds.length, "config and deployment disagree");

        address signer = vm.envOr("MAKER_SIGNER_ADDRESS", address(0));
        if (signer != address(0)) {
            vm.broadcast(c.makerKey);
            c.ch.setQuoteSigner(signer);
            console2.log("maker quote signer set", signer);
        }

        for (uint256 i; i < ms.length; ++i) {
            _bootstrap(c, ms[i], ds[i]);
        }
    }

    function _bootstrap(Ctx memory c, MarketCfg memory m, Deployed memory d) internal {
        uint256 seedBase = vm.parseUint(m.seedBase);
        uint256 seedQuote = vm.parseUint(m.seedQuote);
        uint256 bond = vm.parseUint(m.bond);
        uint256 commit = vm.parseUint(m.makerCommit);
        bool isMockBase = keccak256(bytes(m.mode)) == keccak256("mock");

        vm.startBroadcast(c.creatorKey);
        if (isMockBase) MockERC20(d.base).mintTo(c.creator, seedBase);
        if (c.collateralIsMock) {
            MockERC20(c.collateral).mintTo(c.creator, seedQuote + bond);
            if (commit != 0) MockERC20(c.collateral).mintTo(c.maker, commit);
        }
        vm.stopBroadcast();

        (uint256 r0,) = SpotPool(d.pool).getReserves();
        if (r0 == 0 && seedQuote != 0) {
            if (IERC20(d.base).balanceOf(c.creator) < seedBase || IERC20(c.collateral).balanceOf(c.creator) < seedQuote) {
                console2.log("SKIP seed: creator lacks balance for", m.symbol);
            } else {
                vm.startBroadcast(c.creatorKey);
                IERC20(d.base).approve(d.pool, seedBase);
                IERC20(c.collateral).approve(d.pool, seedQuote);
                bool baseIs0 = SpotPool(d.pool).token0() == d.base;
                SpotPool(d.pool).addLiquidity(
                    baseIs0 ? seedBase : seedQuote,
                    baseIs0 ? seedQuote : seedBase,
                    0,
                    0,
                    c.creator,
                    uint64(block.timestamp + 600)
                );
                vm.stopBroadcast();
                console2.log("seeded pool", m.symbol);
            }
        }

        if (d.feed == address(0)) {
            console2.log("spot only (no approved feed):", m.symbol);
            return;
        }

        if (c.backstop.creatorBond(d.marketId) < bond) {
            if (IERC20(c.collateral).balanceOf(c.creator) < bond) {
                console2.log("SKIP bond: creator lacks collateral for", m.symbol);
            } else {
                vm.startBroadcast(c.creatorKey);
                IERC20(c.collateral).approve(address(c.vault), bond);
                c.vault.deposit(bond, c.creator);
                c.backstop.postBond(d.marketId, bond);
                vm.stopBroadcast();
            }
        }

        if (c.ch.commitTotal(d.marketId) < commit) {
            if (IERC20(c.collateral).balanceOf(c.maker) < commit) {
                console2.log("SKIP backing: maker lacks collateral for", m.symbol);
            } else {
                vm.startBroadcast(c.makerKey);
                IERC20(c.collateral).approve(address(c.vault), commit);
                c.vault.deposit(commit, c.maker);
                c.ch.commitBacking(d.marketId, commit);
                vm.stopBroadcast();
            }
        }

        (uint256 mask, Types.PreflightVerdict verdict) = c.preflight.previewEligibility(d.marketId);
        if (verdict == Types.PreflightVerdict.READY) {
            Types.PerpStatus status = c.registry.getMarket(d.marketId).perpStatus;
            if (status != Types.PerpStatus.ACTIVE) {
                vm.broadcast(c.creatorKey);
                c.preflight.activatePerps(d.marketId);
            }
            console2.log("perps active:", m.symbol);
        } else {
            console2.log("perps NOT activated:", m.symbol, "mask", mask);
        }
    }
}
