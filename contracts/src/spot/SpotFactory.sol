// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {SpotPool} from "./SpotPool.sol";

/// @title SpotFactory
/// @notice Deploys one SpotPool per (sorted token pair, fee tier) with CREATE2 so addresses are predictable.
contract SpotFactory {
    uint8 public constant IMPLEMENTATION_VERSION = 1;

    address public immutable guardian;
    mapping(address => mapping(address => mapping(uint16 => address))) private _pools;
    address[] public allPools;

    error IdenticalTokens();
    error NotAContract();
    error UnsupportedFee();
    error PoolExists();

    event PoolCreated(address indexed pool, address indexed token0, address indexed token1, uint16 feeTier, uint256 index);

    constructor(address guardian_) {
        guardian = guardian_;
    }

    function isSupportedFee(uint16 fee) public pure returns (bool) {
        return fee == 5 || fee == 25 || fee == 100;
    }

    function sortTokens(address a, address b) public pure returns (address token0, address token1) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function getPool(address a, address b, uint16 fee) external view returns (address) {
        (address t0, address t1) = sortTokens(a, b);
        return _pools[t0][t1][fee];
    }

    function poolCount() external view returns (uint256) {
        return allPools.length;
    }

    function poolSalt(address token0, address token1, uint16 fee) public pure returns (bytes32) {
        return keccak256(abi.encode(token0, token1, fee, IMPLEMENTATION_VERSION));
    }

    function createPool(address a, address b, uint16 fee) external returns (address pool) {
        if (a == b) revert IdenticalTokens();
        if (!isSupportedFee(fee)) revert UnsupportedFee();
        (address t0, address t1) = sortTokens(a, b);
        if (t0.code.length == 0 || t1.code.length == 0) revert NotAContract();
        if (_pools[t0][t1][fee] != address(0)) revert PoolExists();
        pool = address(new SpotPool{salt: poolSalt(t0, t1, fee)}(t0, t1, fee, guardian));
        _pools[t0][t1][fee] = pool;
        allPools.push(pool);
        emit PoolCreated(pool, t0, t1, fee, allPools.length - 1);
    }
}
