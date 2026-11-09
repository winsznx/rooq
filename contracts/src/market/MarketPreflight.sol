// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Types} from "../lib/Types.sol";

interface IRegistryForPreflight {
    function getMarket(bytes32 marketId) external view returns (Types.Market memory);
    function getTier(uint16 tierId) external view returns (Types.RiskParams memory);
    function tierWithinBounds(Types.RiskParams memory p) external view returns (bool);
    function activatePerp(bytes32 marketId) external;
    function vault() external view returns (address);
}

interface IOracleForPreflight {
    function isApproved(bytes32 feedId) external view returns (bool);
    function isFresh(bytes32 feedId) external view returns (bool);
    function assetOf(bytes32 feedId) external view returns (address);
}

interface IClearingHouseForPreflight {
    function commitTotal(bytes32 marketId) external view returns (uint256);
    function badDebt(bytes32 marketId) external view returns (uint256);
}

interface IBackstopForPreflight {
    function creatorBond(bytes32 marketId) external view returns (uint256);
}

interface IPoolReserves {
    function getReserves() external view returns (uint256, uint256);
}

interface IVaultCollateral {
    function collateral() external view returns (address);
}

/// @title MarketPreflight
/// @notice Deterministic launch readiness. Every check is a live onchain read; there is no weighted score.
///         `previewEligibility` and `previewAsset` are free views a creator runs before paying gas.
///         `activatePerps` re-runs every check in the same transaction, so an earlier "Ready" grants nothing.
contract MarketPreflight {
    uint256 public constant CHECK_BASE_CONTRACT = 1 << 0;
    uint256 public constant CHECK_DECIMALS = 1 << 1;
    uint256 public constant CHECK_COLLATERAL = 1 << 2;
    uint256 public constant CHECK_SPOT_FUNDED = 1 << 3;
    uint256 public constant CHECK_FEED_APPROVED = 1 << 4;
    uint256 public constant CHECK_FEED_FRESH = 1 << 5;
    uint256 public constant CHECK_RISK_BOUNDS = 1 << 6;
    uint256 public constant CHECK_MAKER_BACKING = 1 << 7;
    uint256 public constant CHECK_BOND = 1 << 8;
    uint256 public constant CHECK_NO_BAD_DEBT = 1 << 9;
    uint256 public constant CHECK_REGISTERED = 1 << 10;
    uint256 public constant ALL_CHECKS = (1 << 11) - 1;

    uint256 private constant HARD_CHECKS = CHECK_BASE_CONTRACT | CHECK_DECIMALS | CHECK_COLLATERAL | CHECK_NO_BAD_DEBT;
    uint256 private constant FEED_CHECKS = CHECK_FEED_APPROVED | CHECK_FEED_FRESH | CHECK_REGISTERED;
    uint256 private constant BACKING_CHECKS = CHECK_MAKER_BACKING | CHECK_BOND | CHECK_SPOT_FUNDED;

    IRegistryForPreflight public immutable registry;
    IOracleForPreflight public immutable oracle;
    IClearingHouseForPreflight public immutable clearingHouse;
    IBackstopForPreflight public immutable backstop;

    error NotEligible(uint256 passedMask);

    event PerpsActivated(bytes32 indexed marketId, address indexed by, uint256 passedMask);

    constructor(address registry_, address oracle_, address clearingHouse_, address backstop_) {
        registry = IRegistryForPreflight(registry_);
        oracle = IOracleForPreflight(oracle_);
        clearingHouse = IClearingHouseForPreflight(clearingHouse_);
        backstop = IBackstopForPreflight(backstop_);
    }

    function previewEligibility(bytes32 marketId)
        public
        view
        returns (uint256 mask, Types.PreflightVerdict verdict)
    {
        Types.Market memory m = registry.getMarket(marketId);
        mask = _assetChecks(m.base, m.quote);
        if (_spotFunded(m.pool)) mask |= CHECK_SPOT_FUNDED;
        bool registered = m.perpStatus == Types.PerpStatus.REGISTERED || m.perpStatus == Types.PerpStatus.ACTIVE
            || m.perpStatus == Types.PerpStatus.CLOSE_ONLY;
        if (registered) {
            mask |= CHECK_REGISTERED;
            mask |= _feedChecks(m.feedId, m.base);
            if (registry.tierWithinBounds(m.risk)) mask |= CHECK_RISK_BOUNDS;
            if (clearingHouse.commitTotal(marketId) >= m.risk.minMakerBacking) mask |= CHECK_MAKER_BACKING;
            if (backstop.creatorBond(marketId) >= m.risk.minBond) mask |= CHECK_BOND;
        }
        if (clearingHouse.badDebt(marketId) == 0) mask |= CHECK_NO_BAD_DEBT;
        verdict = _verdict(mask);
    }

    /// @notice Readiness for a market that does not exist yet, from the creator's planned commitments.
    function previewAsset(Types.PreflightInput calldata input)
        external
        view
        returns (uint256 mask, Types.PreflightVerdict verdict)
    {
        mask = _assetChecks(input.base, input.quote) | CHECK_REGISTERED | CHECK_NO_BAD_DEBT;
        if (input.plannedSpotQuote > 0) mask |= CHECK_SPOT_FUNDED;
        mask |= _feedChecks(input.feedId, input.base);
        Types.RiskParams memory tier = registry.getTier(input.tierId);
        if (registry.tierWithinBounds(tier)) {
            mask |= CHECK_RISK_BOUNDS;
            if (input.plannedBacking >= tier.minMakerBacking) mask |= CHECK_MAKER_BACKING;
            if (input.plannedBond >= tier.minBond) mask |= CHECK_BOND;
        }
        verdict = _verdict(mask);
    }

    /// @notice Permissionless. Activates perps only if every check passes against live state right now.
    function activatePerps(bytes32 marketId) external {
        (uint256 mask,) = previewEligibility(marketId);
        if (mask != ALL_CHECKS) revert NotEligible(mask);
        registry.activatePerp(marketId);
        emit PerpsActivated(marketId, msg.sender, mask);
    }

    function _assetChecks(address base, address quote) internal view returns (uint256 mask) {
        if (base.code.length != 0) {
            mask |= CHECK_BASE_CONTRACT;
            (bool ok, bytes memory ret) = base.staticcall(abi.encodeCall(IERC20Metadata.decimals, ()));
            if (ok && ret.length == 32 && abi.decode(ret, (uint256)) <= 18) mask |= CHECK_DECIMALS;
        }
        if (quote == IVaultCollateral(registry.vault()).collateral()) mask |= CHECK_COLLATERAL;
    }

    function _feedChecks(bytes32 feedId, address base) internal view returns (uint256 mask) {
        if (feedId == bytes32(0) || !oracle.isApproved(feedId) || oracle.assetOf(feedId) != base) return 0;
        mask = CHECK_FEED_APPROVED;
        if (oracle.isFresh(feedId)) mask |= CHECK_FEED_FRESH;
    }

    function _spotFunded(address pool) internal view returns (bool) {
        if (pool == address(0)) return false;
        (uint256 r0, uint256 r1) = IPoolReserves(pool).getReserves();
        return r0 != 0 && r1 != 0;
    }

    function _verdict(uint256 mask) internal pure returns (Types.PreflightVerdict) {
        if (mask & HARD_CHECKS != HARD_CHECKS) return Types.PreflightVerdict.BLOCKED;
        if (mask & FEED_CHECKS != FEED_CHECKS) return Types.PreflightVerdict.NEEDS_FEED;
        if (mask & CHECK_RISK_BOUNDS == 0) return Types.PreflightVerdict.BLOCKED;
        if (mask & BACKING_CHECKS != BACKING_CHECKS) return Types.PreflightVerdict.NEEDS_BACKING;
        return Types.PreflightVerdict.READY;
    }
}
