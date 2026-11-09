// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Types} from "../lib/Types.sol";

interface IVaultLedger {
    function FREE() external view returns (bytes32);
    function balanceOf(bytes32 domain, address account) external view returns (uint256);
    function move(bytes32 fromDomain, address from, bytes32 toDomain, address to, uint256 amount) external;
}

interface IRegistryView {
    function getMarket(bytes32 marketId) external view returns (Types.Market memory);
}

interface IClearingHouseOi {
    function totalOpenInterest(bytes32 marketId) external view returns (uint256);
}

/// @title MarketBackstop
/// @notice Per-market insurance and creator first-loss bond. Each market has its own ledger domain, so a
///         shortfall in one market can never draw on another market's reserves.
/// @dev Loss waterfall after a liquidated account's own margin: (1) this market's insurance, (2) this
///      market's creator bond, (3) recorded bad debt plus forced close-only in the ClearingHouse.
///      There is no auto-deleveraging in V1.
contract MarketBackstop {
    IVaultLedger public immutable vault;
    IRegistryView public immutable registry;
    address private immutable _deployer;
    address public clearingHouse;

    mapping(bytes32 marketId => uint256) public insuranceOf;
    mapping(bytes32 marketId => mapping(address creator => uint256)) public bondOf;

    error NotClearingHouse();
    error NotDeployer();
    error AlreadyWired();
    error NotCreator();
    error BondLocked();
    error ZeroAmount();

    event InsuranceDeposited(bytes32 indexed marketId, address indexed from, uint256 amount);
    event InsuranceCredited(bytes32 indexed marketId, uint256 amount);
    event BondPosted(bytes32 indexed marketId, address indexed creator, uint256 amount);
    event BondWithdrawn(bytes32 indexed marketId, address indexed creator, uint256 amount);
    event ShortfallCovered(bytes32 indexed marketId, uint256 requested, uint256 fromInsurance, uint256 fromBond);

    constructor(address vault_, address registry_, address deployer_) {
        vault = IVaultLedger(vault_);
        registry = IRegistryView(registry_);
        _deployer = deployer_;
    }

    function wireClearingHouse(address clearingHouse_) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (clearingHouse != address(0)) revert AlreadyWired();
        clearingHouse = clearingHouse_;
    }

    function domain(bytes32 marketId) public pure returns (bytes32) {
        return keccak256(abi.encode("ROOQ_BACKSTOP", marketId));
    }

    function depositInsurance(bytes32 marketId, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        registry.getMarket(marketId);
        vault.move(vault.FREE(), msg.sender, domain(marketId), address(this), amount);
        insuranceOf[marketId] += amount;
        emit InsuranceDeposited(marketId, msg.sender, amount);
    }

    function postBond(bytes32 marketId, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (registry.getMarket(marketId).creator != msg.sender) revert NotCreator();
        vault.move(vault.FREE(), msg.sender, domain(marketId), msg.sender, amount);
        bondOf[marketId][msg.sender] += amount;
        emit BondPosted(marketId, msg.sender, amount);
    }

    /// @notice The bond stays locked while the market can carry risk or still has open interest.
    function withdrawBond(bytes32 marketId) external {
        Types.Market memory m = registry.getMarket(marketId);
        if (m.creator != msg.sender) revert NotCreator();
        bool riskBearing = m.perpStatus == Types.PerpStatus.ACTIVE || m.perpStatus == Types.PerpStatus.CLOSE_ONLY
            || m.perpStatus == Types.PerpStatus.PAUSED || m.perpStatus == Types.PerpStatus.SETTLEMENT_PENDING;
        if (riskBearing || IClearingHouseOi(clearingHouse).totalOpenInterest(marketId) != 0) revert BondLocked();
        uint256 amount = bondOf[marketId][msg.sender];
        if (amount == 0) revert ZeroAmount();
        bondOf[marketId][msg.sender] = 0;
        vault.move(domain(marketId), msg.sender, vault.FREE(), msg.sender, amount);
        emit BondWithdrawn(marketId, msg.sender, amount);
    }

    /// @notice Pays up to `amount` into (toDomain, to). Returns what was actually covered.
    function coverShortfall(bytes32 marketId, bytes32 toDomain, address to, uint256 amount)
        external
        returns (uint256 covered)
    {
        if (msg.sender != clearingHouse) revert NotClearingHouse();
        bytes32 d = domain(marketId);
        uint256 fromInsurance = _min(amount, insuranceOf[marketId]);
        if (fromInsurance != 0) {
            insuranceOf[marketId] -= fromInsurance;
            vault.move(d, address(this), toDomain, to, fromInsurance);
        }
        uint256 fromBond;
        uint256 remaining = amount - fromInsurance;
        if (remaining != 0) {
            address creator = registry.getMarket(marketId).creator;
            fromBond = _min(remaining, bondOf[marketId][creator]);
            if (fromBond != 0) {
                bondOf[marketId][creator] -= fromBond;
                vault.move(d, creator, toDomain, to, fromBond);
            }
        }
        covered = fromInsurance + fromBond;
        emit ShortfallCovered(marketId, amount, fromInsurance, fromBond);
    }

    /// @notice ClearingHouse routes the insurance share of liquidation penalties here.
    function creditInsurance(bytes32 marketId, bytes32 fromDomain, address from, uint256 amount) external {
        if (msg.sender != clearingHouse) revert NotClearingHouse();
        if (amount == 0) return;
        vault.move(fromDomain, from, domain(marketId), address(this), amount);
        insuranceOf[marketId] += amount;
        emit InsuranceCredited(marketId, amount);
    }

    function coverage(bytes32 marketId) external view returns (uint256) {
        return insuranceOf[marketId] + bondOf[marketId][registry.getMarket(marketId).creator];
    }

    function creatorBond(bytes32 marketId) external view returns (uint256) {
        return bondOf[marketId][registry.getMarket(marketId).creator];
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
