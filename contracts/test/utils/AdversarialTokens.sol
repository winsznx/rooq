// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Burns 1% of every transfer. Used to prove the vault and pools reject non-standard transfer semantics.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee On Transfer (Test)", "FOT") {}

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

interface IReenterTarget {
    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minOut, address to, uint64 deadline)
        external
        returns (uint256);
}

/// @notice Attempts to re-enter the pool from inside transferFrom.
contract ReentrantToken is ERC20 {
    address public target;
    bool public armed;

    constructor() ERC20("Reentrant (Test)", "REN") {}

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_) external {
        target = target_;
        armed = true;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (armed) {
            armed = false;
            IReenterTarget(target).swapExactIn(address(this), 1, 0, from, type(uint64).max);
        }
        return super.transferFrom(from, to, value);
    }
}
