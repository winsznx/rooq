// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RiscZeroGroth16Verifier} from "risc0/groth16/RiscZeroGroth16Verifier.sol";
import {ControlID} from "risc0/groth16/ControlID.sol";

/// ADR-P03: genuine RISC Zero Groth16 receipt (risc0 3.0.6, risc0-ethereum v3.0.1) verified on the EVM.
contract Risc0GasTest is Test {
    RiscZeroGroth16Verifier internal verifier;
    bytes32 internal IMAGE_ID;

    function setUp() public {
        IMAGE_ID = vm.envBytes32("RISC0_IMAGE_ID");
        verifier = new RiscZeroGroth16Verifier(ControlID.CONTROL_ROOT, ControlID.BN254_CONTROL_ID);
    }

    function _load() internal view returns (bytes memory seal, bytes32 journalDigest) {
        seal = bytes.concat(verifier.SELECTOR(), vm.readFileBinary("../risc0/out/transfer.seal"));
        journalDigest = sha256(vm.readFileBinary("../risc0/out/transfer.journal"));
    }

    function test_transferReceiptVerifies() public {
        (bytes memory seal, bytes32 jd) = _load();
        uint256 before = gasleft();
        verifier.verify(seal, IMAGE_ID, jd);
        emit log_named_uint("risc0 groth16 verify gas", before - gasleft());
        emit log_named_uint("risc0 seal bytes", seal.length);
    }

    function test_tamperedJournalRejected() public {
        (bytes memory seal, bytes32 jd) = _load();
        vm.expectRevert();
        verifier.verify(seal, IMAGE_ID, bytes32(uint256(jd) ^ 1));
    }

    function test_otherImageRejected() public {
        (bytes memory seal, bytes32 jd) = _load();
        vm.expectRevert();
        verifier.verify(seal, bytes32(uint256(IMAGE_ID) ^ 1), jd);
    }
}
