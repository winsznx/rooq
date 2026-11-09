// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Chainlink's standard read interface. Robinhood Chain Stock Token feeds implement it.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function version() external view returns (uint256);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
