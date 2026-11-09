// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {HonkVerifier as PerpOpenVerifier} from "../src/perp_open_verifier.sol";

/// PV-02 / ADR-P03 experiment: deploys the benchmark perp_open UltraHonk verifier. Proof checks are then made
/// with eth_call by scripts/pv02-46630.sh, so only the deployment costs gas. This verifier is a benchmark
/// fixture, not a Rooq production contract.
contract DeployVerifier is Script {
    function run() external returns (address verifier) {
        require(block.chainid == 46630 || block.chainid == 31337, "unexpected chain");
        vm.startBroadcast();
        verifier = address(new PerpOpenVerifier());
        vm.stopBroadcast();
        console2.log("perp_open verifier", verifier);
    }
}
