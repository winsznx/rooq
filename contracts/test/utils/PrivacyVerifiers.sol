// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IHonkVerifier} from "../../src/privacy/ShieldedPool.sol";
import {PairTypes} from "../../src/privacy/PairTypes.sol";

/// @notice Deploys the generated Honk verifiers from their artifacts. PrivatePairs compiles via IR, and anything that imports
///         it joins that compilation; importing the verifiers there too would push them through IR, which they do not survive.
library PrivacyVerifiers {
    Vm internal constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function deploy(string memory name) internal returns (IHonkVerifier) {
        return IHonkVerifier(VM.deployCode(string.concat(name, ".sol:", name)));
    }

    function pairs() internal returns (PairTypes.Verifiers memory) {
        return PairTypes.Verifiers(
            deploy("LockVerifier"),
            deploy("OpenPairVerifier"),
            deploy("LiquidateVerifier"),
            deploy("ReleaseVerifier"),
            deploy("FundingEpochVerifier"),
            deploy("ClosePairVerifier"),
            deploy("ExitRequestVerifier"),
            deploy("PairUpdateVerifier")
        );
    }
}
