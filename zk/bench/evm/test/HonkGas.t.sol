// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HonkVerifier as TransferVerifier} from "../src/transfer_verifier.sol";
import {HonkVerifier as PerpOpenVerifier} from "../src/perp_open_verifier.sol";

interface IVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

/// ADR-P03: genuine UltraHonk (ZK, keccak transcript) proofs from bb 5.3.0 verified by the generated Solidity
/// verifiers, plus rejection of tampered proofs, tampered public inputs and the wrong verifier.
contract HonkGasTest is Test {
    IVerifier internal transfer;
    IVerifier internal perpOpen;

    function setUp() public {
        transfer = IVerifier(address(new TransferVerifier()));
        perpOpen = IVerifier(address(new PerpOpenVerifier()));
    }

    function _load(string memory name) internal view returns (bytes memory proof, bytes32[] memory inputs) {
        proof = vm.readFileBinary(string.concat("../noir/out/", name, "/proof"));
        bytes memory raw = vm.readFileBinary(string.concat("../noir/out/", name, "/public_inputs"));
        inputs = new bytes32[](raw.length / 32);
        for (uint256 i; i < inputs.length; i++) {
            bytes32 w;
            assembly ("memory-safe") {
                w := mload(add(add(raw, 32), mul(i, 32)))
            }
            inputs[i] = w;
        }
    }

    function _gas(IVerifier v, bytes memory proof, bytes32[] memory inputs) internal returns (bool ok, uint256 used) {
        uint256 before = gasleft();
        try v.verify(proof, inputs) returns (bool r) {
            ok = r;
        } catch {
            ok = false;
        }
        used = before - gasleft();
    }

    function test_transferProofVerifies() public {
        (bytes memory proof, bytes32[] memory inputs) = _load("transfer");
        (bool ok, uint256 used) = _gas(transfer, proof, inputs);
        assertTrue(ok);
        emit log_named_uint("transfer verify gas", used);
        emit log_named_uint("transfer calldata bytes", proof.length + inputs.length * 32);
    }

    function test_perpOpenProofVerifies() public {
        (bytes memory proof, bytes32[] memory inputs) = _load("perp_open");
        (bool ok, uint256 used) = _gas(perpOpen, proof, inputs);
        assertTrue(ok);
        emit log_named_uint("perp_open verify gas", used);
        emit log_named_uint("perp_open calldata bytes", proof.length + inputs.length * 32);
    }

    function test_tamperedProofRejected() public {
        (bytes memory proof, bytes32[] memory inputs) = _load("perp_open");
        for (uint256 off = 64; off < proof.length; off += proof.length / 7) {
            bytes memory bad = bytes.concat(proof);
            bad[off] = bytes1(uint8(bad[off]) ^ 0x01);
            (bool ok,) = _gas(perpOpen, bad, inputs);
            assertFalse(ok, "tampered proof accepted");
        }
    }

    function test_tamperedPublicInputRejected() public {
        (bytes memory proof, bytes32[] memory inputs) = _load("perp_open");
        for (uint256 i; i < inputs.length; i++) {
            bytes32[] memory bad = new bytes32[](inputs.length);
            for (uint256 j; j < inputs.length; j++) {
                bad[j] = inputs[j];
            }
            bad[i] = bytes32(uint256(bad[i]) ^ 1);
            (bool ok,) = _gas(perpOpen, proof, bad);
            assertFalse(ok, "tampered public input accepted");
        }
    }

    function test_proofForOtherCircuitRejected() public {
        (bytes memory proof, bytes32[] memory inputs) = _load("transfer");
        (bool ok,) = _gas(perpOpen, proof, inputs);
        assertFalse(ok);
    }
}
