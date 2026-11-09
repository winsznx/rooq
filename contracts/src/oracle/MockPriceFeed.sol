// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @title MockPriceFeed
/// @notice TEST FIXTURE ONLY. An AggregatorV3-compatible feed whose answer is written by one operator.
///         On testnet the operator is the Rooq oracle relay (apps/maker/src/relay.ts), which copies the
///         multiplier-adjusted mid price from Robinhood's public /rhj/prices API. It is labelled TEST in
///         every UI surface because it is a single-operator relay, not an independent oracle network.
contract MockPriceFeed is AggregatorV3Interface {
    uint8 public immutable override decimals;
    string public override description;
    address public operator;
    uint256 public constant override version = 1;

    uint80 private _roundId;
    int256 private _answer;
    uint256 private _updatedAt;

    error NotOperator();

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);
    event OperatorTransferred(address indexed from, address indexed to);

    constructor(uint8 decimals_, string memory description_, address operator_) {
        decimals = decimals_;
        description = description_;
        operator = operator_;
    }

    function setAnswer(int256 answer) external {
        if (msg.sender != operator) revert NotOperator();
        _roundId += 1;
        _answer = answer;
        _updatedAt = block.timestamp;
        emit AnswerUpdated(answer, _roundId, block.timestamp);
    }

    function transferOperator(address next) external {
        if (msg.sender != operator) revert NotOperator();
        emit OperatorTransferred(operator, next);
        operator = next;
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }
}
