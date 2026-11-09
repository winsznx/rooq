// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Types} from "../lib/Types.sol";
import {SignedMath} from "@openzeppelin/contracts/utils/math/SignedMath.sol";

/// @title QuoteVerifier
/// @notice EIP-712 maker quote verification with atomic replay protection.
/// @dev Domain: name "Rooq", version "1", block.chainid, verifyingContract = the ClearingHouse. A quote
///      signed for one chain or one ClearingHouse deployment cannot be used on another.
///      Replay: a nonce bitmap per maker plus a monotonic floor. A quote's nonce is consumed when its
///      signed size is fully filled; partial fills are tracked per quote hash and can never exceed the
///      signed size. Makers may delegate signing to a hot key that can only sign quotes, never move funds.
///      EIP-1271 contract signers are intentionally not supported in V1.
abstract contract QuoteVerifier is EIP712 {
    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(bytes32 marketId,address maker,address taker,int256 size,uint256 price,uint256 minFill,uint256 nonce,uint64 deadline,uint32 policyVersion)"
    );

    mapping(address maker => mapping(uint256 word => uint256 bits)) private _nonceBitmap;
    mapping(address maker => uint256) public nonceFloor;
    mapping(bytes32 quoteHash => uint256 filledAbs) public quoteFilled;
    mapping(address maker => address signer) public quoteSigner;

    error BadSignature();
    error NonceUsed(address maker, uint256 nonce);
    error QuoteExpired(uint64 deadline);
    error OverFill(uint256 alreadyFilled, uint256 requested, uint256 signedSize);
    error BelowMinFill(uint256 requested, uint256 minFill);
    error WrongTaker(address expected, address actual);
    error PolicyVersionMismatch(uint32 quoteVersion, uint32 marketVersion);
    error DirectionMismatch();
    error FloorMustIncrease();

    event QuoteSignerSet(address indexed maker, address indexed signer);
    event NonceCancelled(address indexed maker, uint256 nonce);
    event NonceFloorRaised(address indexed maker, uint256 floor);
    event QuoteConsumed(bytes32 indexed quoteHash, address indexed maker, uint256 nonce, uint256 filledAbs, bool exhausted);

    constructor() EIP712("Rooq", "1") {}

    function hashQuote(Types.Quote memory q) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    QUOTE_TYPEHASH,
                    q.marketId,
                    q.maker,
                    q.taker,
                    q.size,
                    q.price,
                    q.minFill,
                    q.nonce,
                    q.deadline,
                    q.policyVersion
                )
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function isNonceUsed(address maker, uint256 nonce) public view returns (bool) {
        if (nonce < nonceFloor[maker]) return true;
        return _nonceBitmap[maker][nonce >> 8] & (1 << (nonce & 0xff)) != 0;
    }

    /// @notice Delegate quote signing. Zero revokes. Takes effect in the same block.
    function setQuoteSigner(address signer) external {
        quoteSigner[msg.sender] = signer;
        emit QuoteSignerSet(msg.sender, signer);
    }

    function cancelNonce(uint256 nonce) external {
        _useNonce(msg.sender, nonce);
        emit NonceCancelled(msg.sender, nonce);
    }

    /// @notice Invalidates every outstanding quote with a nonce below `floor`.
    function raiseNonceFloor(uint256 floor) external {
        if (floor <= nonceFloor[msg.sender]) revert FloorMustIncrease();
        nonceFloor[msg.sender] = floor;
        emit NonceFloorRaised(msg.sender, floor);
    }

    function _useNonce(address maker, uint256 nonce) private {
        _nonceBitmap[maker][nonce >> 8] |= 1 << (nonce & 0xff);
    }

    /// @return h The EIP-712 digest of the quote, used as its fill-accounting key.
    function _consumeQuote(Types.Quote calldata q, bytes calldata sig, int256 fill, uint32 marketVersion, address taker)
        internal
        returns (bytes32 h)
    {
        if (block.timestamp > q.deadline) revert QuoteExpired(q.deadline);
        if (q.policyVersion != marketVersion) revert PolicyVersionMismatch(q.policyVersion, marketVersion);
        if (q.taker != address(0) && q.taker != taker) revert WrongTaker(q.taker, taker);
        if (fill == 0 || q.size == 0 || (fill > 0) != (q.size > 0)) revert DirectionMismatch();
        if (isNonceUsed(q.maker, q.nonce)) revert NonceUsed(q.maker, q.nonce);

        h = _verifySigner(q, sig);
        _recordFill(h, q, fill);
    }

    function _verifySigner(Types.Quote calldata q, bytes calldata sig) private view returns (bytes32 h) {
        h = hashQuote(q);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(h, sig);
        if (err != ECDSA.RecoverError.NoError) revert BadSignature();
        if (signer == q.maker) return h;
        address delegated = quoteSigner[q.maker];
        if (delegated == address(0) || signer != delegated) revert BadSignature();
    }

    function _recordFill(bytes32 h, Types.Quote calldata q, int256 fill) private {
        uint256 absFill = SignedMath.abs(fill);
        uint256 absSize = SignedMath.abs(q.size);
        uint256 filled = quoteFilled[h];
        if (filled + absFill > absSize) revert OverFill(filled, absFill, absSize);
        if (absFill < q.minFill && filled + absFill != absSize) revert BelowMinFill(absFill, q.minFill);
        filled += absFill;
        quoteFilled[h] = filled;
        bool exhausted = filled == absSize;
        if (exhausted) _useNonce(q.maker, q.nonce);
        emit QuoteConsumed(h, q.maker, q.nonce, filled, exhausted);
    }
}
