// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

/// @title Rooq shared types
/// @notice Units used everywhere in the perp engine:
///         - prices: 18-decimal USD per 1 base unit (WAD), normalised from the feed's own decimals
///         - sizes: 18-decimal base units, signed (+ long, - short) from the taker's point of view
///         - margin, fees, PnL transfers: collateral token units (e.g. 6 decimals for USDG)
///         - fractions (IMR, MMR, funding rates): WAD, where 1e18 = 100%
library Types {
    enum SpotStatus {
        NONE,
        ACTIVE,
        PAUSED
    }

    /// @dev Transitions are enforced in MarketRegistry. Only MarketPreflight can move a market to ACTIVE.
    enum PerpStatus {
        NONE,
        REGISTERED,
        ACTIVE,
        CLOSE_ONLY,
        PAUSED,
        SETTLEMENT_PENDING,
        SETTLED
    }

    enum PreflightVerdict {
        READY,
        NEEDS_FEED,
        NEEDS_BACKING,
        BLOCKED
    }

    /// @notice Immutable ceiling for every tier and market. Set once in the MarketRegistry constructor.
    struct GlobalBounds {
        uint256 minImrWad;
        uint256 minMmrWad;
        uint256 maxOiUsdWad;
        uint16 maxTakerFeeBps;
        uint16 maxLiqPenaltyBps;
        uint16 maxDeviationBps;
        uint256 maxFundingRatePerHourWad;
    }

    struct RiskParams {
        uint256 imrWad;
        uint256 mmrWad;
        uint256 maxOiUsdWad;
        uint16 takerFeeBps;
        uint16 makerFeeBps;
        uint16 liqPenaltyBps;
        uint16 maxDeviationBps;
        uint256 maxFundingRatePerHourWad;
        uint256 minMakerBacking;
        uint256 minBond;
        uint32 version;
    }

    struct Market {
        bytes32 id;
        address base;
        address quote;
        address creator;
        address pool;
        SpotStatus spotStatus;
        PerpStatus perpStatus;
        uint16 tierId;
        bytes32 feedId;
        uint64 createdAt;
        RiskParams risk;
    }

    /// @notice A maker's firm, collateral-backed RFQ quote, signed with EIP-712.
    /// @param size Taker-perspective signed base size the maker will take the other side of.
    ///        Positive: the taker may buy (go long or reduce a short). Negative: the taker may sell.
    /// @param taker Zero allows any taker; otherwise only that address may fill.
    /// @param minFill Smallest partial fill in base units, except for the final remainder.
    /// @param policyVersion Must equal the market's risk version, so a quote can't outlive a risk change.
    struct Quote {
        bytes32 marketId;
        address maker;
        address taker;
        int256 size;
        uint256 price;
        uint256 minFill;
        uint256 nonce;
        uint64 deadline;
        uint32 policyVersion;
    }

    /// @notice Bounds the taker attaches to their own transaction.
    /// @param fillSize Signed size to fill, same direction as the quote.
    /// @param marginDeposit Collateral moved from the taker's free vault balance into this position.
    /// @param limitPrice Worst acceptable price: a ceiling when buying, a floor when selling.
    struct TradeParams {
        int256 fillSize;
        uint256 marginDeposit;
        uint256 limitPrice;
        uint16 maxFeeBps;
        uint64 deadline;
    }

    struct PairView {
        address taker;
        address maker;
        int256 size;
        uint256 entryPrice;
        uint256 takerMargin;
        uint256 makerMargin;
        int256 realizedPnl;
        int256 fundingSnapshot;
    }

    struct PreflightInput {
        address base;
        address quote;
        bytes32 feedId;
        uint16 tierId;
        uint256 plannedBacking;
        uint256 plannedBond;
        uint256 plannedSpotQuote;
    }
}
