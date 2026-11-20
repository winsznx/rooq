// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IHonkVerifier} from "../../src/privacy/ShieldedPool.sol";

contract AcceptAllVerifier is IHonkVerifier {
    function verify(bytes calldata, bytes32[] calldata) external pure returns (bool) {
        return true;
    }
}

contract RejectAllVerifier is IHonkVerifier {
    function verify(bytes calldata, bytes32[] calldata) external pure returns (bool) {
        return false;
    }
}

/// Accepts exactly one public-input vector, standing in for a proof generated against it.
contract InputBoundVerifier is IHonkVerifier {
    bytes32 public expected;

    function bind(bytes32[] calldata inputs) external {
        expected = keccak256(abi.encode(inputs));
    }

    function verify(bytes calldata, bytes32[] calldata inputs) external view returns (bool) {
        return keccak256(abi.encode(inputs)) == expected;
    }
}

/// Accepts every proof until told to capture, then reverts with the public inputs it was given, so a test can read exactly what
/// a contract passed. `verify` is view, so a revert is the only way to get them out.
contract CapturingVerifier is IHonkVerifier {
    error Captured(bytes32[] inputs);

    bool public capturing;

    function capture(bool on) external {
        capturing = on;
    }

    function verify(bytes calldata, bytes32[] calldata inputs) external view returns (bool) {
        if (capturing) revert Captured(inputs);
        return true;
    }
}

/// Helpers for reading CapturingVerifier reverts and for checking an input vector's length against a generated Honk verifier.
library Inputs {
    error PublicInputsLengthWrong();
    error ProofLengthWrongWithLogN(uint256 logN, uint256 actualLength, uint256 expectedLength);

    function decode(bytes memory reason) internal pure returns (bytes32[] memory) {
        require(bytes4(reason) == CapturingVerifier.Captured.selector, "verifier was not reached");
        bytes memory body = new bytes(reason.length - 4);
        for (uint256 i; i < body.length; i++) body[i] = reason[i + 4];
        return abi.decode(body, (bytes32[]));
    }

    /// True when `real` gets past its public-input count check. A zero proof of the right size reaches that check and then
    /// fails later, so any revert other than PublicInputsLengthWrong means the count is right.
    function lengthAccepted(IHonkVerifier real, bytes32[] memory inputs) internal view returns (bool) {
        uint256 size;
        try real.verify(new bytes(0), inputs) {
            revert("empty proof accepted");
        } catch (bytes memory r) {
            require(bytes4(r) == ProofLengthWrongWithLogN.selector, "unexpected proof size error");
            bytes memory body = new bytes(r.length - 4);
            for (uint256 i; i < body.length; i++) body[i] = r[i + 4];
            (,, size) = abi.decode(body, (uint256, uint256, uint256));
        }
        try real.verify(new bytes(size), inputs) returns (bool) {
            return true;
        } catch (bytes memory r) {
            return bytes4(r) != PublicInputsLengthWrong.selector;
        }
    }
}
