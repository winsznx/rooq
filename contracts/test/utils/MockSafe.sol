// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

/// Stands in for Safe v1.4.1 in tests: the same setup, getThreshold and getOwners, plus `exec` so a test can act as the Safe.
/// Signature collection is not modelled; an owner calling `exec` represents a transaction the threshold has signed.
contract MockSafe {
    address[] internal _owners;
    uint256 internal _threshold;

    function setup(address[] calldata owners, uint256 threshold, address, bytes calldata, address, address, uint256, address payable) external {
        require(_threshold == 0, "already set up");
        _owners = owners;
        _threshold = threshold;
    }

    function getThreshold() external view returns (uint256) {
        return _threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function exec(address to, bytes calldata data) external returns (bytes memory) {
        bool owner;
        for (uint256 i; i < _owners.length; i++) if (_owners[i] == msg.sender) owner = true;
        require(owner, "not an owner");
        (bool ok, bytes memory ret) = to.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }
}

contract MockSafeProxyFactory {
    function createProxyWithNonce(address, bytes memory initializer, uint256 saltNonce) external returns (address proxy) {
        proxy = address(new MockSafe{salt: bytes32(saltNonce)}());
        (bool ok,) = proxy.call(initializer);
        require(ok, "setup failed");
    }
}
