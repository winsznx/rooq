// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SignedMath} from "@openzeppelin/contracts/utils/math/SignedMath.sol";

/// @title RiskMath
/// @notice Pure fixed-point perp arithmetic. `crates/risk-kernel` implements the same functions and
///         `test/RiskParity.t.sol` checks both produce identical integers on shared vectors.
/// @dev Rounding rules, chosen so no path can create collateral:
///      - margin requirements and fees round UP (against the account)
///      - health-check PnL rounds toward negative infinity (against the account)
///      - realised PnL transfers round toward zero, and the SAME integer is debited from one side and
///        credited to the other, so the transfer is exactly zero-sum
///      - funding owed rounds its magnitude UP against the payer; again one integer moves between two margins
library RiskMath {
    using SafeCast for uint256;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    function abs(int256 x) internal pure returns (uint256) {
        return SignedMath.abs(x);
    }

    function notionalUp(uint256 absSize, uint256 price) internal pure returns (uint256) {
        return Math.mulDiv(absSize, price, WAD, Math.Rounding.Ceil);
    }

    /// @notice Collateral required for `absSize` at `price` under `fractionWad` (IMR or MMR), in token units.
    function marginRequirement(uint256 absSize, uint256 price, uint256 fractionWad, uint256 scale)
        internal
        pure
        returns (uint256)
    {
        uint256 reqWad = Math.mulDiv(notionalUp(absSize, price), fractionWad, WAD, Math.Rounding.Ceil);
        return Math.ceilDiv(reqWad, scale);
    }

    function fee(uint256 absSize, uint256 price, uint256 feeBps, uint256 scale) internal pure returns (uint256) {
        uint256 feeWad = Math.mulDiv(notionalUp(absSize, price), feeBps, BPS, Math.Rounding.Ceil);
        return Math.ceilDiv(feeWad, scale);
    }

    /// @notice size * (exit - entry), in WAD^2 units. Callers divide by WAD * scale.
    function _rawPnl(int256 size, uint256 entry, uint256 exit) private pure returns (int256) {
        return size * (exit.toInt256() - entry.toInt256());
    }

    /// @notice Realised PnL in token units, truncated toward zero. Used for transfers.
    function pnlTrunc(int256 size, uint256 entry, uint256 exit, uint256 scale) internal pure returns (int256) {
        return _rawPnl(size, entry, exit) / (WAD * scale).toInt256();
    }

    /// @notice Unrealised PnL in token units, rounded toward negative infinity. Used for health checks.
    function pnlFloor(int256 size, uint256 entry, uint256 mark, uint256 scale) internal pure returns (int256) {
        return floorDiv(_rawPnl(size, entry, mark), (WAD * scale).toInt256());
    }

    function floorDiv(int256 a, int256 b) internal pure returns (int256 q) {
        q = a / b;
        if ((a % b != 0) && ((a < 0) != (b < 0))) q -= 1;
    }

    /// @notice Volume-weighted entry for a same-direction increase. Floors; both sides of a pair share it.
    function weightedEntry(uint256 absOld, uint256 oldEntry, uint256 absAdd, uint256 addPrice)
        internal
        pure
        returns (uint256)
    {
        return (absOld * oldEntry + absAdd * addPrice) / (absOld + absAdd);
    }

    /// @notice Skew-based funding rate per second (WAD fraction of price). Positive: longs pay shorts.
    /// @dev rate = maxRate * (longOi - shortOi) / (longOi + shortOi). Depends only on onchain OI.
    function fundingRatePerSecond(uint256 longOi, uint256 shortOi, uint256 maxRatePerHourWad)
        internal
        pure
        returns (int256)
    {
        uint256 total = longOi + shortOi;
        if (total == 0) return 0;
        int256 maxPerSecond = (maxRatePerHourWad / 3600).toInt256();
        int256 skewWad = ((longOi.toInt256() - shortOi.toInt256()) * WAD.toInt256()) / total.toInt256();
        return (maxPerSecond * skewWad) / WAD.toInt256();
    }

    /// @notice Funding index increment in WAD USD per base unit for `dt` seconds at `price`.
    function fundingIndexDelta(int256 ratePerSecond, uint256 dt, uint256 price) internal pure returns (int256) {
        return (ratePerSecond * dt.toInt256() * price.toInt256()) / WAD.toInt256();
    }

    /// @notice Funding owed by the taker side of a pair, in token units. Positive: taker pays maker.
    function fundingOwed(int256 size, int256 indexDelta, uint256 scale) internal pure returns (int256) {
        int256 raw = size * indexDelta;
        if (raw == 0) return 0;
        uint256 mag = Math.ceilDiv(abs(raw), WAD * scale);
        return raw > 0 ? mag.toInt256() : -mag.toInt256();
    }

    function liquidationPenalty(uint256 absSize, uint256 mark, uint256 penaltyBps, uint256 scale)
        internal
        pure
        returns (uint256)
    {
        return fee(absSize, mark, penaltyBps, scale);
    }
}
