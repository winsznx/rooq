// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SpotMath} from "../lib/SpotMath.sol";

/// @title SpotPool
/// @notice Rooq's own constant-product pool for two standard ERC-20 tokens. The ERC-20 of this contract
///         is the LP share.
/// @dev Reserves are tracked internally and only change through this contract's functions, so token
///      donations never move the price or inflate shares. Every inbound transfer is checked by balance
///      delta, which rejects fee-on-transfer and other non-standard tokens. Fees stay in the reserves and
///      accrue to LPs pro rata. The guardian can pause swaps and deposits; withdrawals always work.
///      Pool reserves are never perp margin: this contract has no connection to the MarginVault.
contract SpotPool is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MINIMUM_LIQUIDITY = 1_000;
    address private constant DEAD = address(0xdead);
    uint256 private constant BPS = 10_000;

    address public immutable token0;
    address public immutable token1;
    uint16 public immutable feeBps;
    address public immutable guardian;
    address public immutable factory;

    uint256 private _reserve0;
    uint256 private _reserve1;
    /// @notice Cumulative swap fees paid in each token, for transparent attribution (not an APY).
    uint256 public feesAccrued0;
    uint256 public feesAccrued1;
    bool public paused;

    error Expired();
    error InvalidToken();
    error ZeroAmount();
    error ZeroOutput();
    error InsufficientOutput(uint256 amountOut, uint256 minOut);
    error InsufficientLiquidityMinted();
    error SlippageExceeded();
    error BalanceDeltaMismatch();
    error PoolIsPaused();
    error NotGuardian();
    error InvariantViolated();

    event LiquidityAdded(address indexed sender, address indexed owner, uint256 amount0, uint256 amount1, uint256 shares);
    event LiquidityRemoved(
        address indexed sender, address indexed recipient, uint256 amount0, uint256 amount1, uint256 shares
    );
    event SwapExecuted(
        address indexed sender,
        address indexed recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );
    event ReservesUpdated(uint256 reserve0, uint256 reserve1);
    event PoolPaused(uint8 reasonCode);
    event PoolUnpaused();
    event Skimmed(address indexed to, uint256 amount0, uint256 amount1);

    modifier notExpired(uint64 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PoolIsPaused();
        _;
    }

    constructor(address token0_, address token1_, uint16 feeBps_, address guardian_)
        ERC20("Rooq LP share", "rqLP")
    {
        token0 = token0_;
        token1 = token1_;
        feeBps = feeBps_;
        guardian = guardian_;
        factory = msg.sender;
    }

    function getReserves() external view returns (uint256, uint256) {
        return (_reserve0, _reserve1);
    }

    function quoteExactIn(address tokenIn, uint256 amountIn) external view returns (uint256) {
        (uint256 rIn, uint256 rOut) = _orient(tokenIn);
        return SpotMath.getAmountOut(amountIn, rIn, rOut, feeBps);
    }

    function addLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        address to,
        uint64 deadline
    ) external nonReentrant notExpired(deadline) whenNotPaused returns (uint256 amount0, uint256 amount1, uint256 shares) {
        uint256 supply = totalSupply();
        if (supply == 0) {
            (amount0, amount1) = (amount0Desired, amount1Desired);
            uint256 root = SpotMath.sqrt(amount0 * amount1);
            if (root <= MINIMUM_LIQUIDITY) revert InsufficientLiquidityMinted();
            shares = root - MINIMUM_LIQUIDITY;
            _mint(DEAD, MINIMUM_LIQUIDITY);
        } else {
            uint256 optimal1 = (amount0Desired * _reserve1) / _reserve0;
            if (optimal1 <= amount1Desired) {
                (amount0, amount1) = (amount0Desired, optimal1);
            } else {
                (amount0, amount1) = ((amount1Desired * _reserve0) / _reserve1, amount1Desired);
            }
            shares = SpotMath.sharesFor(amount0, amount1, _reserve0, _reserve1, supply);
        }
        if (amount0 < amount0Min || amount1 < amount1Min) revert SlippageExceeded();
        if (shares == 0) revert InsufficientLiquidityMinted();
        _pull(token0, amount0);
        _pull(token1, amount1);
        _setReserves(_reserve0 + amount0, _reserve1 + amount1);
        _mint(to, shares);
        emit LiquidityAdded(msg.sender, to, amount0, amount1, shares);
    }

    /// @notice Always available, including while paused.
    function removeLiquidity(uint256 shares, uint256 amount0Min, uint256 amount1Min, address to, uint64 deadline)
        external
        nonReentrant
        notExpired(deadline)
        returns (uint256 amount0, uint256 amount1)
    {
        if (shares == 0) revert ZeroAmount();
        uint256 supply = totalSupply();
        amount0 = (shares * _reserve0) / supply;
        amount1 = (shares * _reserve1) / supply;
        if (amount0 < amount0Min || amount1 < amount1Min) revert SlippageExceeded();
        _burn(msg.sender, shares);
        _setReserves(_reserve0 - amount0, _reserve1 - amount1);
        IERC20(token0).safeTransfer(to, amount0);
        IERC20(token1).safeTransfer(to, amount1);
        emit LiquidityRemoved(msg.sender, to, amount0, amount1, shares);
    }

    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minOut, address to, uint64 deadline)
        external
        nonReentrant
        notExpired(deadline)
        whenNotPaused
        returns (uint256 amountOut)
    {
        if (tokenIn != token0 && tokenIn != token1) revert InvalidToken();
        if (amountIn == 0) revert ZeroAmount();
        bool zeroForOne = tokenIn == token0;
        (uint256 rIn, uint256 rOut) = zeroForOne ? (_reserve0, _reserve1) : (_reserve1, _reserve0);
        amountOut = SpotMath.getAmountOut(amountIn, rIn, rOut, feeBps);
        if (amountOut == 0) revert ZeroOutput();
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);

        _pull(tokenIn, amountIn);
        IERC20(zeroForOne ? token1 : token0).safeTransfer(to, amountOut);
        uint256 fee = _applySwap(zeroForOne, rIn, rOut, amountIn, amountOut);
        _emitSwap(to, zeroForOne, amountIn, amountOut, fee);
    }

    function _emitSwap(address to, bool zeroForOne, uint256 amountIn, uint256 amountOut, uint256 fee) private {
        (address tIn, address tOut) = zeroForOne ? (token0, token1) : (token1, token0);
        emit SwapExecuted(msg.sender, to, tIn, tOut, amountIn, amountOut, fee);
    }

    function _applySwap(bool zeroForOne, uint256 rIn, uint256 rOut, uint256 amountIn, uint256 amountOut)
        private
        returns (uint256 fee)
    {
        uint256 newIn = rIn + amountIn;
        uint256 newOut = rOut - amountOut;
        if (newIn * newOut < rIn * rOut) revert InvariantViolated();
        fee = (amountIn * feeBps) / BPS;
        if (zeroForOne) {
            feesAccrued0 += fee;
            _setReserves(newIn, newOut);
        } else {
            feesAccrued1 += fee;
            _setReserves(newOut, newIn);
        }
    }

    /// @notice Sends tokens held above tracked reserves (donations) to `to`. Never touches reserves.
    function skim(address to) external nonReentrant {
        uint256 extra0 = IERC20(token0).balanceOf(address(this)) - _reserve0;
        uint256 extra1 = IERC20(token1).balanceOf(address(this)) - _reserve1;
        if (extra0 != 0) IERC20(token0).safeTransfer(to, extra0);
        if (extra1 != 0) IERC20(token1).safeTransfer(to, extra1);
        emit Skimmed(to, extra0, extra1);
    }

    function pause(uint8 reasonCode) external {
        if (msg.sender != guardian) revert NotGuardian();
        paused = true;
        emit PoolPaused(reasonCode);
    }

    function unpause() external {
        if (msg.sender != guardian) revert NotGuardian();
        paused = false;
        emit PoolUnpaused();
    }

    function _orient(address tokenIn) internal view returns (uint256 rIn, uint256 rOut) {
        if (tokenIn == token0) return (_reserve0, _reserve1);
        if (tokenIn == token1) return (_reserve1, _reserve0);
        revert InvalidToken();
    }

    function _pull(address token, uint256 amount) internal {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert BalanceDeltaMismatch();
    }

    function _setReserves(uint256 r0, uint256 r1) internal {
        _reserve0 = r0;
        _reserve1 = r1;
        emit ReservesUpdated(r0, r1);
    }
}
