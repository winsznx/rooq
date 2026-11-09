// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20
/// @notice TEST FIXTURE ONLY. A plain ERC-20 with a rate-limited public faucet. Names must carry
///         "Mock" / "(Test ...)" so it can never be mistaken for a canonical asset such as USDG.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;
    address public immutable owner;
    uint256 public immutable faucetLimit;
    uint256 public constant FAUCET_COOLDOWN = 1 hours;
    mapping(address => uint256) public lastFaucetAt;

    error NotOwner();
    error FaucetDisabled();
    error FaucetAmountTooLarge(uint256 requested, uint256 limit);
    error FaucetCoolingDown(uint256 availableAt);

    event FaucetUsed(address indexed to, uint256 amount);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 faucetLimit_)
        ERC20(name_, symbol_)
    {
        _decimals = decimals_;
        owner = msg.sender;
        faucetLimit = faucetLimit_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mintTo(address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        _mint(to, amount);
    }

    function faucet(uint256 amount) external {
        if (faucetLimit == 0) revert FaucetDisabled();
        if (amount > faucetLimit) revert FaucetAmountTooLarge(amount, faucetLimit);
        uint256 next = lastFaucetAt[msg.sender] + FAUCET_COOLDOWN;
        if (lastFaucetAt[msg.sender] != 0 && block.timestamp < next) revert FaucetCoolingDown(next);
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, amount);
        emit FaucetUsed(msg.sender, amount);
    }
}
