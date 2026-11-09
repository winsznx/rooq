// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {RiskMath} from "../lib/RiskMath.sol";
import {Types} from "../lib/Types.sol";

interface IClearingHouseView {
    function getPair(bytes32 marketId, address taker) external view returns (Types.PairView memory);
    function fundingIndex(bytes32 marketId) external view returns (int256);
    function openInterest(bytes32 marketId) external view returns (uint256 longOi, uint256 shortOi);
    function scale() external view returns (uint256);
}

interface IRegistryView {
    function getMarket(bytes32 marketId) external view returns (Types.Market memory);
}

interface IOracleView {
    function getPrice(bytes32 feedId) external view returns (uint256 priceWad, uint256 updatedAt, bool fresh);
}

/// @title PerpLens
/// @notice Read-only aggregation for the app, keeper and indexer reconciliation. Holds no state and has
///         no authority: every number is recomputed from ClearingHouse, registry and oracle reads.
contract PerpLens {
    IClearingHouseView public immutable clearingHouse;
    IRegistryView public immutable registry;
    IOracleView public immutable oracle;

    struct Health {
        int256 takerEquity;
        int256 makerEquity;
        uint256 initialMargin;
        uint256 maintenanceMargin;
        uint256 mark;
        uint256 markUpdatedAt;
        bool fresh;
        int256 pendingFunding;
        bool takerLiquidatable;
        bool makerLiquidatable;
    }

    constructor(address clearingHouse_, address registry_, address oracle_) {
        clearingHouse = IClearingHouseView(clearingHouse_);
        registry = IRegistryView(registry_);
        oracle = IOracleView(oracle_);
    }

    /// @notice Equity includes unsettled funding. Liquidatable flags are true only with a fresh price,
    ///         matching the onchain liquidation predicate.
    function health(bytes32 marketId, address taker) external view returns (Health memory h) {
        Types.Market memory m = registry.getMarket(marketId);
        Types.PairView memory v = clearingHouse.getPair(marketId, taker);
        (h.mark, h.markUpdatedAt, h.fresh) = oracle.getPrice(m.feedId);
        if (v.size == 0 || h.mark == 0) return h;
        uint256 scale = clearingHouse.scale();
        h.pendingFunding = RiskMath.fundingOwed(v.size, clearingHouse.fundingIndex(marketId) - v.fundingSnapshot, scale);
        h.takerEquity = int256(v.takerMargin) + RiskMath.pnlFloor(v.size, v.entryPrice, h.mark, scale) - h.pendingFunding;
        h.makerEquity = int256(v.makerMargin) + RiskMath.pnlFloor(-v.size, v.entryPrice, h.mark, scale) + h.pendingFunding;
        h.initialMargin = RiskMath.marginRequirement(RiskMath.abs(v.size), h.mark, m.risk.imrWad, scale);
        h.maintenanceMargin = RiskMath.marginRequirement(RiskMath.abs(v.size), h.mark, m.risk.mmrWad, scale);
        h.takerLiquidatable = h.fresh && h.takerEquity < int256(h.maintenanceMargin);
        h.makerLiquidatable = h.fresh && h.makerEquity < int256(h.maintenanceMargin);
    }

    function fundingRatePerSecond(bytes32 marketId) external view returns (int256) {
        Types.Market memory m = registry.getMarket(marketId);
        (uint256 longOi, uint256 shortOi) = clearingHouse.openInterest(marketId);
        return RiskMath.fundingRatePerSecond(longOi, shortOi, m.risk.maxFundingRatePerHourWad);
    }

    /// @notice Estimated liquidation price for a taker position, ignoring future funding and fees.
    ///         Advisory only; the onchain predicate is equity < maintenance margin at a fresh mark.
    function estimatedLiquidationPrice(bytes32 marketId, address taker) external view returns (uint256) {
        Types.Market memory m = registry.getMarket(marketId);
        Types.PairView memory v = clearingHouse.getPair(marketId, taker);
        if (v.size == 0) return 0;
        uint256 scale = clearingHouse.scale();
        // Long:  margin + q(P - E) = mmr * q * P  =>  P = (q*E - margin) / (q * (1 - mmr))
        // Short: margin + q(P - E) = mmr * |q| * P with q < 0  =>  P = (|q|*E + margin) / (|q| * (1 + mmr))
        uint256 q = RiskMath.abs(v.size);
        uint256 marginWad = v.takerMargin * scale;
        uint256 qe = (q * v.entryPrice) / 1e18;
        if (v.size > 0) {
            if (marginWad >= qe) return 0;
            return ((qe - marginWad) * 1e18) / ((q * (1e18 - m.risk.mmrWad)) / 1e18);
        }
        return ((qe + marginWad) * 1e18) / ((q * (1e18 + m.risk.mmrWad)) / 1e18);
    }
}
