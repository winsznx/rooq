// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SpotPool} from "./SpotPool.sol";

interface ISpotFactory {
    function getPool(address a, address b, uint16 fee) external view returns (address);
}

/// @title SpotRouter
/// @notice Exact-input routing through Rooq pools only. Liquidity is added and removed on the pool
///         itself (one approval, no intermediary custody), so the router only swaps. It resolves pools from the factory, approves
///         exactly the hop amount, and ends every call holding nothing. No arbitrary call targets.
contract SpotRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    ISpotFactory public immutable factory;

    error BadPath();
    error PoolNotFound(address tokenA, address tokenB, uint16 fee);
    error InsufficientOutput(uint256 amountOut, uint256 minOut);
    error Expired();
    error BalanceDeltaMismatch();

    constructor(address factory_) {
        factory = ISpotFactory(factory_);
    }

    function quoteExactInput(address[] calldata path, uint16[] calldata fees, uint256 amountIn)
        external
        view
        returns (uint256 amountOut)
    {
        _checkPath(path, fees);
        amountOut = amountIn;
        for (uint256 i; i < fees.length; ++i) {
            amountOut = SpotPool(_pool(path[i], path[i + 1], fees[i])).quoteExactIn(path[i], amountOut);
        }
    }

    function swapExactInput(
        address[] calldata path,
        uint16[] calldata fees,
        uint256 amountIn,
        uint256 minOut,
        address to,
        uint64 deadline
    ) external nonReentrant returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        _checkPath(path, fees);
        _pullExact(path[0], amountIn);
        amountOut = amountIn;
        for (uint256 i; i < fees.length; ++i) {
            address pool = _pool(path[i], path[i + 1], fees[i]);
            address recipient = i == fees.length - 1 ? to : address(this);
            IERC20(path[i]).forceApprove(pool, amountOut);
            amountOut = SpotPool(pool).swapExactIn(path[i], amountOut, 0, recipient, deadline);
        }
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
    }

    function _checkPath(address[] calldata path, uint16[] calldata fees) internal pure {
        if (path.length < 2 || path.length > 3 || fees.length != path.length - 1) revert BadPath();
    }

    function _pool(address a, address b, uint16 fee) internal view returns (address pool) {
        pool = factory.getPool(a, b, fee);
        if (pool == address(0)) revert PoolNotFound(a, b, fee);
    }

    function _pullExact(address token, uint256 amount) internal {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert BalanceDeltaMismatch();
    }
}
