// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Types} from "../lib/Types.sol";

interface ISpotFactoryLike {
    function getPool(address a, address b, uint16 fee) external view returns (address);
    function createPool(address a, address b, uint16 fee) external returns (address);
}

interface IOracleLike {
    function isApproved(bytes32 feedId) external view returns (bool);
    function assetOf(bytes32 feedId) external view returns (address);
}

interface IVaultLike {
    function collateral() external view returns (address);
}

interface IOpenInterestLike {
    function totalOpenInterest(bytes32 marketId) external view returns (uint256);
}

/// @title MarketRegistry
/// @notice One market identity per (base, quote): a spot pool plus an optional, isolated perp market.
/// @dev Creation is permissionless. Perp activation is rule-enforced: only MarketPreflight can set
///      ACTIVE, and only after rechecking live state. The guardian can only reduce risk. Every tier and
///      every market is bounded by `bounds`, fixed at construction, so neither the admin nor a creator
///      can exceed them.
contract MarketRegistry is AccessControl {
    uint256 internal constant WAD = 1e18;
    uint32 public constant MARKET_CONFIG_VERSION = 1;
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant PREFLIGHT_ROLE = keccak256("PREFLIGHT_ROLE");
    bytes32 public constant CLEARING_HOUSE_ROLE = keccak256("CLEARING_HOUSE_ROLE");
    /// @dev Admin role for the two wired roles. It administers itself and nobody holds it, so neither it nor
    ///      the wired roles can be granted after wire(). Without the self-admin, DEFAULT_ADMIN_ROLE could grant it.
    bytes32 private constant LOCKED_ROLE = keccak256("LOCKED_ROLE");

    address public immutable vault;
    ISpotFactoryLike public immutable factory;
    IOracleLike public immutable oracle;

    uint256 public immutable minImrWad;
    uint256 public immutable minMmrWad;
    uint256 public immutable maxOiUsdWad;
    uint16 public immutable maxTakerFeeBps;
    uint16 public immutable maxLiqPenaltyBps;
    uint16 public immutable maxDeviationBps;
    uint256 public immutable maxFundingRatePerHourWad;

    address public clearingHouse;
    bool private _wired;

    mapping(bytes32 => Types.Market) private _markets;
    bytes32[] private _marketIds;
    mapping(uint16 => Types.RiskParams) private _tiers;
    mapping(address => bool) public isQuoteAsset;
    /// @notice Set when the guardian restricts a market; only the admin can lift it before preflight reactivates.
    mapping(bytes32 => bool) public guardianHold;

    error NotAContract();
    error IdenticalAssets();
    error UnsupportedDecimals();
    error QuoteNotApproved();
    error CollateralUnsupported();
    error MarketExists();
    error UnknownMarket(bytes32 marketId);
    error NotCreator();
    error UnknownTier(uint16 tierId);
    error OutOfBounds(string field);
    error FeedNotApproved(bytes32 feedId);
    error FeedAssetMismatch(address feedAsset, address marketBase);
    error PerpAlreadyProposed();
    error TransitionNotAllowed();
    error OpenInterestRemaining();
    error AlreadyWired();
    error GuardianHold();

    event MarketCreated(
        bytes32 indexed marketId, address indexed base, address indexed quote, address creator, address pool
    );
    event PerpProposed(bytes32 indexed marketId, uint16 tierId, bytes32 feedId, uint256 maxOiUsdWad, uint32 version);
    event StatusChanged(bytes32 indexed marketId, Types.PerpStatus from, Types.PerpStatus to, address indexed by);
    event RiskTightened(bytes32 indexed marketId, uint256 maxOiUsdWad, uint256 imrWad);
    event TierSet(uint16 indexed tierId, Types.RiskParams params);
    event QuoteAssetSet(address indexed asset, bool approved);

    constructor(
        address admin,
        address guardian,
        address vault_,
        address factory_,
        address oracle_,
        Types.GlobalBounds memory b
    ) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
        _setRoleAdmin(PREFLIGHT_ROLE, LOCKED_ROLE);
        _setRoleAdmin(CLEARING_HOUSE_ROLE, LOCKED_ROLE);
        _setRoleAdmin(LOCKED_ROLE, LOCKED_ROLE);
        vault = vault_;
        factory = ISpotFactoryLike(factory_);
        oracle = IOracleLike(oracle_);
        if (b.minMmrWad == 0 || b.minImrWad <= b.minMmrWad || b.minImrWad > WAD) revert OutOfBounds("bounds");
        minImrWad = b.minImrWad;
        minMmrWad = b.minMmrWad;
        maxOiUsdWad = b.maxOiUsdWad;
        maxTakerFeeBps = b.maxTakerFeeBps;
        maxLiqPenaltyBps = b.maxLiqPenaltyBps;
        maxDeviationBps = b.maxDeviationBps;
        maxFundingRatePerHourWad = b.maxFundingRatePerHourWad;
    }

    /// @notice One-time wiring of the contracts allowed to change perp status.
    function wire(address clearingHouse_, address preflight_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_wired) revert AlreadyWired();
        _wired = true;
        clearingHouse = clearingHouse_;
        _grantRole(CLEARING_HOUSE_ROLE, clearingHouse_);
        _grantRole(PREFLIGHT_ROLE, preflight_);
    }

    function setTier(uint16 tierId, Types.RiskParams calldata p) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _checkBounds(p);
        _tiers[tierId] = p;
        emit TierSet(tierId, p);
    }

    function setQuoteAsset(address asset, bool approved) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (asset.code.length == 0) revert NotAContract();
        isQuoteAsset[asset] = approved;
        emit QuoteAssetSet(asset, approved);
    }

    // ------------------------------------------------------------------ creation

    function computeMarketId(address base, address quote) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), base, quote, MARKET_CONFIG_VERSION));
    }

    /// @notice Permissionless. Registers the market identity and links (or deploys) its spot pool.
    function createMarket(address base, address quote, uint16 poolFeeBps) external returns (bytes32 marketId) {
        if (base.code.length == 0 || quote.code.length == 0) revert NotAContract();
        if (base == quote) revert IdenticalAssets();
        if (!isQuoteAsset[quote]) revert QuoteNotApproved();
        try IERC20Metadata(base).decimals() returns (uint8 d) {
            if (d > 18) revert UnsupportedDecimals();
        } catch {
            revert UnsupportedDecimals();
        }
        marketId = computeMarketId(base, quote);
        if (_markets[marketId].base != address(0)) revert MarketExists();

        address pool = factory.getPool(base, quote, poolFeeBps);
        if (pool == address(0)) pool = factory.createPool(base, quote, poolFeeBps);

        Types.Market storage m = _markets[marketId];
        m.id = marketId;
        m.base = base;
        m.quote = quote;
        m.creator = msg.sender;
        m.pool = pool;
        m.spotStatus = Types.SpotStatus.ACTIVE;
        m.createdAt = uint64(block.timestamp);
        _marketIds.push(marketId);
        emit MarketCreated(marketId, base, quote, msg.sender, pool);
    }

    /// @notice Creator attaches a perp configuration. This does NOT activate trading.
    function proposePerp(bytes32 marketId, uint16 tierId, bytes32 feedId, uint256 maxOi) external {
        Types.Market storage m = _market(marketId);
        if (msg.sender != m.creator) revert NotCreator();
        if (m.perpStatus != Types.PerpStatus.NONE) revert PerpAlreadyProposed();
        if (m.quote != IVaultLike(vault).collateral()) revert CollateralUnsupported();
        Types.RiskParams memory tier = _tiers[tierId];
        if (tier.version == 0) revert UnknownTier(tierId);
        if (maxOi == 0 || maxOi > tier.maxOiUsdWad) revert OutOfBounds("maxOi");
        if (!oracle.isApproved(feedId)) revert FeedNotApproved(feedId);
        address feedAsset = oracle.assetOf(feedId);
        if (feedAsset != m.base) revert FeedAssetMismatch(feedAsset, m.base);

        tier.maxOiUsdWad = maxOi;
        m.tierId = tierId;
        m.feedId = feedId;
        m.risk = tier;
        _setStatus(m, Types.PerpStatus.REGISTERED);
        emit PerpProposed(marketId, tierId, feedId, maxOi, tier.version);
    }

    // ------------------------------------------------------------------ status

    /// @notice Only callable by MarketPreflight after it has rechecked every activation condition.
    function activatePerp(bytes32 marketId) external onlyRole(PREFLIGHT_ROLE) {
        Types.Market storage m = _market(marketId);
        if (m.perpStatus != Types.PerpStatus.REGISTERED && m.perpStatus != Types.PerpStatus.CLOSE_ONLY) {
            revert TransitionNotAllowed();
        }
        if (guardianHold[marketId]) revert GuardianHold();
        _setStatus(m, Types.PerpStatus.ACTIVE);
    }

    /// @notice ClearingHouse moves a market to close-only on stale prices or recorded bad debt.
    function reportCloseOnly(bytes32 marketId) external onlyRole(CLEARING_HOUSE_ROLE) {
        Types.Market storage m = _market(marketId);
        if (m.perpStatus == Types.PerpStatus.ACTIVE) _setStatus(m, Types.PerpStatus.CLOSE_ONLY);
    }

    /// @notice Guardian transitions. Every allowed move reduces risk; none returns a market to ACTIVE.
    function setPerpStatus(bytes32 marketId, Types.PerpStatus to) external onlyRole(GUARDIAN_ROLE) {
        Types.Market storage m = _market(marketId);
        Types.PerpStatus from = m.perpStatus;
        bool ok;
        if (to == Types.PerpStatus.CLOSE_ONLY) {
            ok = from == Types.PerpStatus.ACTIVE || from == Types.PerpStatus.PAUSED;
        } else if (to == Types.PerpStatus.PAUSED) {
            ok = from == Types.PerpStatus.ACTIVE || from == Types.PerpStatus.CLOSE_ONLY;
        } else if (to == Types.PerpStatus.SETTLEMENT_PENDING) {
            ok = from == Types.PerpStatus.ACTIVE || from == Types.PerpStatus.CLOSE_ONLY
                || from == Types.PerpStatus.PAUSED;
        } else if (to == Types.PerpStatus.SETTLED) {
            ok = from == Types.PerpStatus.SETTLEMENT_PENDING;
            if (ok && IOpenInterestLike(clearingHouse).totalOpenInterest(marketId) != 0) {
                revert OpenInterestRemaining();
            }
        }
        if (!ok) revert TransitionNotAllowed();
        guardianHold[marketId] = true;
        _setStatus(m, to);
    }

    /// @notice Lifts a guardian restriction. The market still returns to ACTIVE only through preflight.
    function releaseGuardianHold(bytes32 marketId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _market(marketId);
        guardianHold[marketId] = false;
    }

    /// @notice Guardian may lower the OI cap or raise initial margin. Maintenance margin never changes,
    ///         so tightening cannot make a healthy existing position liquidatable.
    function tightenRisk(bytes32 marketId, uint256 newMaxOi, uint256 newImr) external onlyRole(GUARDIAN_ROLE) {
        Types.Market storage m = _market(marketId);
        if (newMaxOi != 0) {
            if (newMaxOi > m.risk.maxOiUsdWad) revert OutOfBounds("maxOi");
            m.risk.maxOiUsdWad = newMaxOi;
        }
        if (newImr != 0) {
            if (newImr < m.risk.imrWad || newImr > WAD) revert OutOfBounds("imr");
            m.risk.imrWad = newImr;
        }
        emit RiskTightened(marketId, m.risk.maxOiUsdWad, m.risk.imrWad);
    }

    // ------------------------------------------------------------------ views

    function getMarket(bytes32 marketId) external view returns (Types.Market memory) {
        return _market(marketId);
    }

    function marketCount() external view returns (uint256) {
        return _marketIds.length;
    }

    function marketIdAt(uint256 index) external view returns (bytes32) {
        return _marketIds[index];
    }

    function getTier(uint16 tierId) external view returns (Types.RiskParams memory) {
        return _tiers[tierId];
    }

    function globalBounds() external view returns (Types.GlobalBounds memory) {
        return Types.GlobalBounds(
            minImrWad, minMmrWad, maxOiUsdWad, maxTakerFeeBps, maxLiqPenaltyBps, maxDeviationBps, maxFundingRatePerHourWad
        );
    }

    function tierWithinBounds(Types.RiskParams memory p) public view returns (bool) {
        return p.version != 0 && p.imrWad >= minImrWad && p.imrWad <= WAD && p.mmrWad >= minMmrWad
            && p.mmrWad < p.imrWad && p.maxOiUsdWad <= maxOiUsdWad && p.takerFeeBps <= maxTakerFeeBps
            && p.makerFeeBps <= maxTakerFeeBps && p.liqPenaltyBps <= maxLiqPenaltyBps
            && p.maxDeviationBps <= maxDeviationBps && p.maxDeviationBps != 0
            && p.maxFundingRatePerHourWad <= maxFundingRatePerHourWad;
    }

    // ------------------------------------------------------------------ internal

    function _market(bytes32 marketId) internal view returns (Types.Market storage m) {
        m = _markets[marketId];
        if (m.base == address(0)) revert UnknownMarket(marketId);
    }

    function _setStatus(Types.Market storage m, Types.PerpStatus to) internal {
        emit StatusChanged(m.id, m.perpStatus, to, msg.sender);
        m.perpStatus = to;
    }

    function _checkBounds(Types.RiskParams calldata p) internal view {
        if (p.version == 0) revert OutOfBounds("version");
        if (p.imrWad < minImrWad || p.imrWad > WAD) revert OutOfBounds("imr");
        if (p.mmrWad < minMmrWad || p.mmrWad >= p.imrWad) revert OutOfBounds("mmr");
        if (p.maxOiUsdWad > maxOiUsdWad) revert OutOfBounds("maxOi");
        if (p.takerFeeBps > maxTakerFeeBps || p.makerFeeBps > maxTakerFeeBps) revert OutOfBounds("fee");
        if (p.liqPenaltyBps > maxLiqPenaltyBps) revert OutOfBounds("liqPenalty");
        if (p.maxDeviationBps == 0 || p.maxDeviationBps > maxDeviationBps) revert OutOfBounds("deviation");
        if (p.maxFundingRatePerHourWad > maxFundingRatePerHourWad) revert OutOfBounds("funding");
    }
}
