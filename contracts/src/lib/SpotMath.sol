// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title SpotMath
/// @notice Constant-product arithmetic for SpotPool. Mirrored in `crates/risk-kernel` for parity tests.
library SpotMath {
    uint256 internal constant BPS = 10_000;

    /// @notice Exact-input output with the fee taken from the input. Rounds down (favours the pool).
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        internal
        pure
        returns (uint256)
    {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0) return 0;
        uint256 inWithFee = amountIn * (BPS - feeBps);
        return (inWithFee * reserveOut) / (reserveIn * BPS + inWithFee);
    }

    function sqrt(uint256 x) internal pure returns (uint256) {
        return Math.sqrt(x);
    }

    /// @notice Shares for a proportional deposit into a funded pool. Rounds down (favours existing LPs).
    function sharesFor(uint256 amount0, uint256 amount1, uint256 reserve0, uint256 reserve1, uint256 supply)
        internal
        pure
        returns (uint256)
    {
        return Math.min((amount0 * supply) / reserve0, (amount1 * supply) / reserve1);
    }
}
