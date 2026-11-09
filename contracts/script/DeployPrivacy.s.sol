// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MockERC20} from "../src/tokens/MockERC20.sol";
import {AppendVerifier} from "../src/privacy/verifiers/AppendVerifier.sol";
import {SpendVerifier} from "../src/privacy/verifiers/SpendVerifier.sol";
import {ShieldedPool, IHonkVerifier} from "../src/privacy/ShieldedPool.sol";

/// Deploys the W1 private custody slice: generated UltraHonk verifiers and ShieldedPool.
/// This is an INCOMPLETE FIXTURE of private V1 (DEPLOY-01): free notes only, no perps, spot or recovery services.
///   local:   DEPLOYER_PRIVATE_KEY=0x... forge script script/DeployPrivacy.s.sol --rpc-url local --broadcast
///            (deploys a labelled test token as the only supported asset)
///   testnet: PRIVACY_ASSETS=0xUSDG,0xTSLA,... plus the same command with --rpc-url rh_testnet
contract DeployPrivacy is Script {
    function run() external {
        address[] memory assets = vm.envOr("PRIVACY_ASSETS", ",", new address[](0));
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        if (assets.length == 0) {
            require(block.chainid == 31337, "PRIVACY_ASSETS required outside local");
            assets = new address[](1);
            assets[0] = address(new MockERC20("Test USDG (local fixture)", "tUSDG", 6, 1_000_000e6));
        }
        AppendVerifier append = new AppendVerifier();
        SpendVerifier spend = new SpendVerifier();
        ShieldedPool pool = new ShieldedPool(IHonkVerifier(address(append)), IHonkVerifier(address(spend)), assets);
        vm.stopBroadcast();

        string memory o = "privacy";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeString(o, "status", "INCOMPLETE FIXTURE: W1 free-note custody only");
        vm.serializeAddress(o, "appendVerifier", address(append));
        vm.serializeAddress(o, "spendVerifier", address(spend));
        vm.serializeAddress(o, "assets", assets);
        vm.serializeUint(o, "deploymentId", pool.deploymentId());
        vm.serializeUint(o, "startBlock", block.number);
        string memory json = vm.serializeAddress(o, "shieldedPool", address(pool));
        vm.writeJson(json, vm.envOr("PRIVACY_OUT", string.concat("./deployments/privacy-", vm.toString(block.chainid), ".json")));
        console2.log("ShieldedPool", address(pool));
    }
}
