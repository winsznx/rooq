// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {PrivatePairs} from "./PrivatePairs.sol";

/// @notice What a module must expose to be proposed: the custody it was built for.
interface IRooqModule {
    function custody() external view returns (PrivatePairs);
}

/// @title ModuleRegistry
/// @notice The only way to add a module to PrivatePairs custody after deployment. Add-only: a module, once active, can never be
///         removed or paused, and nothing here can disable an existing module or exit.
///
///         Status: built into the Robinhood Chain testnet deployment as a trial. Whether mainnet gets it is decided after the
///         external audit.
///
///         Read this before trusting a proposal: an active module can drain custody. `moduleCreate` appends any leaf, including
///         a FREE note of any asset and amount, and the spend circuit will withdraw it. Custody cannot check hidden values, so
///         there is no on-chain cap. A module with an underconstrained verifier, or one that calls anything mutable, is as
///         dangerous as a malicious one. The protections here are procedural: a timelocked proposer, a public delay of at least
///         14 days that outlasts the 7-day forced exit, a veto any single veto signer can use, and a code hash pinned at
///         proposal next to a manifest anyone can rebuild. If you do not trust a pending module, exit before it activates.
///
///         A module gets `moduleConsume` and `moduleCreate` only. Custody keeps `payBond`, `registerMarket`, `setSweptHead`,
///         `setCloseOnly` and `setOperatorKeys` for the markets module fixed at deployment.
///
///         A module must be contract code that runs itself. An EIP-7702 delegated account is refused at proposal and again at
///         activation: its code hash pins only the 23-byte designator, and its key holder can send plain transactions from the
///         module address without running any module code. A proxy's code hash pins nothing about its implementation either,
///         so a manifest must name the code that actually runs and reviewers should refuse an upgradeable module.
contract ModuleRegistry {
    uint256 public constant MIN_DELAY = 14 days;

    struct Pending {
        bytes32 codehash;
        bytes32 manifest;
        uint64 activatesAt;
    }

    PrivatePairs public immutable custody;
    /// @notice The timelock. Its own delay comes on top of `delay`.
    address public immutable proposer;
    /// @notice A 1-of-3 Safe, so any one honest signer can block a module.
    address public immutable vetoer;
    uint256 public immutable delay;

    mapping(address => Pending) public pending;
    /// @notice A vetoed address can never be proposed again, so veto and re-proposal cannot alternate.
    mapping(address => bool) public vetoed;
    /// @notice Every module activated here, in order.
    address[] public modules;

    error NotProposer();
    error NotVetoer();
    error ZeroAddress();
    error DelayTooShort(uint256 delay);
    error WrongRegistry(address expected);
    error NoCode(address module);
    error DelegatedAccount(address module);
    error ForeignCustody(address module);
    error AlreadyModule(address module);
    error AlreadyPending(address module);
    error Vetoed(address module);
    error NotPending(address module);
    error NotDue(uint256 activatesAt, uint256 timestamp);
    error CodeChanged(address module, bytes32 pinned, bytes32 actual);

    event ModuleProposed(address indexed module, bytes32 codehash, bytes32 manifest, uint256 activatesAt);
    event ModuleWithdrawn(address indexed module);
    event ModuleVetoed(address indexed module);
    event ModuleActivated(address indexed module, bytes32 codehash, bytes32 manifest);

    constructor(PrivatePairs custody_, address proposer_, address vetoer_, uint256 delay_) {
        if (proposer_ == address(0) || vetoer_ == address(0)) revert ZeroAddress();
        if (delay_ < MIN_DELAY) revert DelayTooShort(delay_);
        if (custody_.moduleRegistry() != address(this)) revert WrongRegistry(custody_.moduleRegistry());
        custody = custody_;
        proposer = proposer_;
        vetoer = vetoer_;
        delay = delay_;
    }

    /// @param manifest Hash of the published JSON naming the module's source commit, verifiers, VK hashes and circuit hashes.
    function propose(address m, bytes32 manifest) external {
        if (msg.sender != proposer) revert NotProposer();
        if (m.code.length == 0) revert NoCode(m);
        if (_isDelegated(m)) revert DelegatedAccount(m);
        if (vetoed[m]) revert Vetoed(m);
        if (pending[m].activatesAt != 0) revert AlreadyPending(m);
        if (_isModule(m)) revert AlreadyModule(m);
        if (_custodyOf(m) != address(custody)) revert ForeignCustody(m);
        uint64 activatesAt = uint64(block.timestamp + delay);
        pending[m] = Pending(m.codehash, manifest, activatesAt);
        emit ModuleProposed(m, m.codehash, manifest, activatesAt);
    }

    function withdraw(address m) external {
        if (msg.sender != proposer) revert NotProposer();
        if (pending[m].activatesAt == 0) revert NotPending(m);
        delete pending[m];
        emit ModuleWithdrawn(m);
    }

    function veto(address m) external {
        if (msg.sender != vetoer) revert NotVetoer();
        if (pending[m].activatesAt == 0) revert NotPending(m);
        delete pending[m];
        vetoed[m] = true;
        emit ModuleVetoed(m);
    }

    /// @notice Anyone may activate a proposal once its delay has passed, provided the code is still what was proposed.
    function activate(address m) external {
        Pending memory p = pending[m];
        if (p.activatesAt == 0) revert NotPending(m);
        if (block.timestamp < p.activatesAt) revert NotDue(p.activatesAt, block.timestamp);
        if (_isDelegated(m)) revert DelegatedAccount(m);
        if (m.codehash != p.codehash) revert CodeChanged(m, p.codehash, m.codehash);
        delete pending[m];
        modules.push(m);
        custody.addModule(m);
        emit ModuleActivated(m, p.codehash, p.manifest);
    }

    function moduleCount() external view returns (uint256) {
        return modules.length;
    }

    function _isModule(address m) internal view returns (bool) {
        return custody.isModule(m) || m == custody.spotModule() || m == custody.marketsModule();
    }

    /// @dev EIP-7702 designator: 0xef0100 followed by the 20-byte delegate address.
    function _isDelegated(address m) internal view returns (bool) {
        if (m.code.length != 23) return false;
        bytes memory c = m.code;
        return c[0] == 0xef && c[1] == 0x01 && c[2] == 0x00;
    }

    function _custodyOf(address m) internal view returns (address) {
        try IRooqModule(m).custody() returns (PrivatePairs c) {
            return address(c);
        } catch {
            return address(0);
        }
    }
}
