// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MarginVault
/// @notice The only custodian of perp collateral. Holds one collateral token and a double-entry ledger
///         of (domain, account) balances in that token's own units.
/// @dev Domains: FREE (bytes32(0)) is withdrawable by its owner. Every other domain (a position pair,
///      a maker's market commitment, a market backstop, protocol fees) is locked and can only be moved
///      by the two operator contracts wired once at deployment. Invariant: totalLedger equals the sum
///      of all balances and never exceeds collateral.balanceOf(this). There is no owner, no sweep and
///      no way to add an operator after wiring.
contract MarginVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant FREE = bytes32(0);

    IERC20 public immutable collateral;
    uint8 public immutable collateralDecimals;
    /// @notice 10**(18 - decimals): converts 18-decimal USD amounts into collateral units.
    uint256 public immutable scale;
    address private immutable _deployer;

    address public clearingHouse;
    address public backstop;

    mapping(bytes32 domain => mapping(address account => uint256)) public balanceOf;
    /// @notice Sum of an account's balances outside FREE.
    mapping(address account => uint256) public lockedOf;
    uint256 public totalLedger;

    error NotOperator();
    error NotDeployer();
    error AlreadyWired();
    error ZeroAmount();
    error UnsupportedDecimals();
    error InsufficientBalance(uint256 available, uint256 requested);
    error BalanceDeltaMismatch(uint256 expected, uint256 received);
    /// @dev Keeps every ledger balance below 2^255 so signed PnL arithmetic downstream cannot wrap.
    error LedgerCapExceeded();

    event Deposited(address indexed payer, address indexed account, uint256 amount);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);
    event Moved(bytes32 indexed fromDomain, address indexed from, bytes32 indexed toDomain, address to, uint256 amount);
    event OperatorsWired(address clearingHouse, address backstop);

    constructor(address collateral_, address deployer_) {
        uint8 dec = IERC20Metadata(collateral_).decimals();
        if (dec > 18) revert UnsupportedDecimals();
        collateral = IERC20(collateral_);
        collateralDecimals = dec;
        scale = 10 ** (18 - dec);
        _deployer = deployer_;
    }

    function wireOperators(address clearingHouse_, address backstop_) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (clearingHouse != address(0)) revert AlreadyWired();
        clearingHouse = clearingHouse_;
        backstop = backstop_;
        emit OperatorsWired(clearingHouse_, backstop_);
    }

    /// @notice Credit `account`'s free balance with exactly `amount` pulled from the caller.
    function deposit(uint256 amount, address account) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 before = collateral.balanceOf(address(this));
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = collateral.balanceOf(address(this)) - before;
        if (received != amount) revert BalanceDeltaMismatch(amount, received);
        if (totalLedger + amount > uint256(type(int256).max)) revert LedgerCapExceeded();
        balanceOf[FREE][account] += amount;
        totalLedger += amount;
        emit Deposited(msg.sender, account, amount);
    }

    /// @notice Withdraw from the caller's free balance. Locked domains are never withdrawable here.
    function withdraw(uint256 amount, address to) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 available = balanceOf[FREE][msg.sender];
        if (amount > available) revert InsufficientBalance(available, amount);
        balanceOf[FREE][msg.sender] = available - amount;
        totalLedger -= amount;
        collateral.safeTransfer(to, amount);
        emit Withdrawn(msg.sender, to, amount);
    }

    /// @notice Ledger-only transfer between domains. Cannot create or destroy value.
    function move(bytes32 fromDomain, address from, bytes32 toDomain, address to, uint256 amount) external {
        if (msg.sender != clearingHouse && msg.sender != backstop) revert NotOperator();
        if (amount == 0) return;
        uint256 available = balanceOf[fromDomain][from];
        if (amount > available) revert InsufficientBalance(available, amount);
        balanceOf[fromDomain][from] = available - amount;
        balanceOf[toDomain][to] += amount;
        if (fromDomain != FREE) lockedOf[from] -= amount;
        if (toDomain != FREE) lockedOf[to] += amount;
        emit Moved(fromDomain, from, toDomain, to, amount);
    }

    function availableOf(address account) external view returns (uint256) {
        return balanceOf[FREE][account];
    }
}
