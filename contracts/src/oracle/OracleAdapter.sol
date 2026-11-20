// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title OracleAdapter
/// @notice Validates and normalises approved AggregatorV3 feeds into 18-decimal USD prices.
/// @dev Fail-closed: a price is usable only if the feed is approved, answer > 0, within bounds,
///      not from the future, younger than its heartbeat, and (when configured) the L2 sequencer has
///      been up for longer than the grace period. V1 uses the validated index price as the mark.
///      Privileged actions: `admin` (the timelock) approves and reinstates feeds; `guardian` (a Safe) or `admin` revokes them.
///      Revoke is instant because a compromised feed can liquidate a whole market in one block; reinstating goes back
///      through the timelock, so a rogue revoke is visible and reversible. Neither role can write prices, repoint a
///      feed or touch collateral.
contract OracleAdapter {
    uint256 internal constant WAD = 1e18;

    struct FeedConfig {
        address aggregator;
        address asset;
        uint32 heartbeat;
        uint8 decimals;
        bool approved;
        uint256 minPrice;
        uint256 maxPrice;
    }

    struct FeedInit {
        bytes32 feedId;
        address aggregator;
        address asset;
        uint32 heartbeat;
        uint256 minPrice;
        uint256 maxPrice;
    }

    address public immutable admin;
    address public immutable guardian;
    AggregatorV3Interface public immutable sequencerUptimeFeed;
    uint256 public immutable sequencerGracePeriod;
    mapping(bytes32 feedId => FeedConfig) private _feeds;

    error NotAdmin();
    error BadDecimals(uint8 decimals);
    error BadConfig();
    error FeedNotApproved(bytes32 feedId);
    error PriceStale(bytes32 feedId);
    error PriceInvalid(bytes32 feedId);
    error FeedExists(bytes32 feedId);
    error FeedNotRevoked(bytes32 feedId);

    event FeedRegistered(
        bytes32 indexed feedId, address indexed aggregator, address indexed asset, uint32 heartbeat, uint8 decimals
    );
    event FeedRevoked(bytes32 indexed feedId);
    event FeedReinstated(bytes32 indexed feedId);

    /// @param genesis Feeds approved at deployment, so the deployer never needs to hold `admin`.
    constructor(
        address admin_,
        address guardian_,
        address sequencerUptimeFeed_,
        uint256 gracePeriod_,
        FeedInit[] memory genesis
    ) {
        admin = admin_;
        guardian = guardian_;
        sequencerUptimeFeed = AggregatorV3Interface(sequencerUptimeFeed_);
        sequencerGracePeriod = gracePeriod_;
        for (uint256 i; i < genesis.length; i++) {
            FeedInit memory g = genesis[i];
            _register(g.feedId, g.aggregator, g.asset, g.heartbeat, g.minPrice, g.maxPrice);
        }
    }

    function registerFeed(
        bytes32 feedId,
        address aggregator,
        address asset,
        uint32 heartbeat,
        uint256 minPrice,
        uint256 maxPrice
    ) external {
        if (msg.sender != admin) revert NotAdmin();
        _register(feedId, aggregator, asset, heartbeat, minPrice, maxPrice);
    }

    function _register(
        bytes32 feedId,
        address aggregator,
        address asset,
        uint32 heartbeat,
        uint256 minPrice,
        uint256 maxPrice
    ) internal {
        if (_feeds[feedId].aggregator != address(0)) revert FeedExists(feedId);
        if (aggregator.code.length == 0 || asset == address(0) || heartbeat == 0 || minPrice == 0) {
            revert BadConfig();
        }
        if (maxPrice <= minPrice) revert BadConfig();
        uint8 dec = AggregatorV3Interface(aggregator).decimals();
        if (dec > 18) revert BadDecimals(dec);
        _feeds[feedId] = FeedConfig(aggregator, asset, heartbeat, dec, true, minPrice, maxPrice);
        emit FeedRegistered(feedId, aggregator, asset, heartbeat, dec);
    }

    /// @notice Risk-reducing: a revoked feed makes every market using it fail closed.
    function revokeFeed(bytes32 feedId) external {
        if (msg.sender != guardian && msg.sender != admin) revert NotAdmin();
        _feeds[feedId].approved = false;
        emit FeedRevoked(feedId);
    }

    /// @notice Re-approves a revoked feed with its original configuration. A feed id can never be repointed.
    function reinstateFeed(bytes32 feedId) external {
        if (msg.sender != admin) revert NotAdmin();
        FeedConfig storage f = _feeds[feedId];
        if (f.aggregator == address(0) || f.approved) revert FeedNotRevoked(feedId);
        f.approved = true;
        emit FeedReinstated(feedId);
    }

    function feedConfig(bytes32 feedId) external view returns (FeedConfig memory) {
        return _feeds[feedId];
    }

    function isApproved(bytes32 feedId) public view returns (bool) {
        return _feeds[feedId].approved;
    }

    function assetOf(bytes32 feedId) external view returns (address) {
        return _feeds[feedId].asset;
    }

    /// @notice Never reverts for a registered feed. `fresh == false` means the price must not be used
    ///         for anything that increases risk or liquidates.
    /// @dev An answer that fails validation reports `updatedAt = 0`: dead-oracle timers measure time since a usable
    ///      price, so a source that keeps publishing garbage must not hold them off (audit #20). A round stamped after the current
    ///      block counts as invalid too: its `updatedAt` would hold those timers off for as long as the skew lasts.
    function getPrice(bytes32 feedId) public view returns (uint256 priceWad, uint256 updatedAt, bool fresh) {
        FeedConfig memory f = _feeds[feedId];
        if (!f.approved) return (0, 0, false);
        try AggregatorV3Interface(f.aggregator).latestRoundData() returns (
            uint80, int256 answer, uint256, uint256 updated, uint80
        ) {
            if (answer <= 0) return (0, 0, false);
            uint256 raw = SafeCast.toUint256(answer);
            uint256 factor = 10 ** (18 - f.decimals);
            if (raw > type(uint256).max / factor) return (0, 0, false);
            priceWad = raw * factor;
            if (priceWad < f.minPrice || priceWad > f.maxPrice) return (0, 0, false);
            if (updated > block.timestamp) return (0, 0, false);
            updatedAt = updated;
            fresh = updated != 0 && block.timestamp - updated <= f.heartbeat
                && _sequencerHealthy();
        } catch {
            return (0, 0, false);
        }
    }

    function isFresh(bytes32 feedId) external view returns (bool fresh) {
        (,, fresh) = getPrice(feedId);
    }

    /// @notice Reverting accessor for paths that require a valid price.
    function getFreshPrice(bytes32 feedId) external view returns (uint256 priceWad) {
        FeedConfig memory f = _feeds[feedId];
        if (!f.approved) revert FeedNotApproved(feedId);
        uint256 updatedAt;
        bool fresh;
        (priceWad, updatedAt, fresh) = getPrice(feedId);
        if (priceWad == 0) revert PriceInvalid(feedId);
        if (!fresh) revert PriceStale(feedId);
    }

    function _sequencerHealthy() internal view returns (bool) {
        if (address(sequencerUptimeFeed) == address(0)) return true;
        try sequencerUptimeFeed.latestRoundData() returns (uint80, int256 answer, uint256 startedAt, uint256, uint80) {
            // Chainlink convention: 0 = up, 1 = down. startedAt = when the current status began.
            return answer == 0 && startedAt != 0 && block.timestamp - startedAt > sequencerGracePeriod;
        } catch {
            return false;
        }
    }
}
