// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IHonkVerifier} from "./ShieldedPool.sol";

uint256 constant CT_NOTE = 7;
uint256 constant CT_LOCK = 15;
uint256 constant CT_PAIR = 23;
uint256 constant PAIR_KEYS = 4;
uint256 constant CT_MARKET = 8;
uint256 constant CT_CLAIM = 13;
uint256 constant CLAIM_KEYS = 3;
uint256 constant MARKET_KEYS = 3;
uint256 constant OI_SLOTS = 8;
/// @dev Contract-supplied bounds the circuits check (spec-pairs #5, #14). PrivatePairs re-exports them as public constants.
uint256 constant PAIR_MIN_UPDATE_GAP = 10 minutes;
uint256 constant LOCK_MAX_INTENT_LIFETIME = 7 days;
uint256 constant LOCK_MAX_MAKER_LIFETIME = 30 days;

/// @notice Shared shapes of PrivatePairs and PairInputs.
abstract contract PairTypes {
    struct Point {
        uint256 x;
        uint256 y;
    }

    /// @dev The operator keys a rotation replaces together (D-24).
    struct KeySet {
        Point coordinator;
        Point riskA;
        Point riskB;
    }

    struct Verifiers {
        IHonkVerifier lock;
        IHonkVerifier openPair;
        IHonkVerifier liquidate;
        IHonkVerifier release;
        IHonkVerifier fundingEpoch;
        IHonkVerifier closePair;
        IHonkVerifier exitRequest;
        IHonkVerifier pairUpdate;
    }

    /// @dev The relay fee note every relayed action creates, zero or not, so paid and free calls look the same on chain.
    struct FeeOut {
        bytes32 commitment;
        bytes32[CT_NOTE] ct;
    }

    struct FeeRecipient {
        uint256 auth;
        Point key;
    }

    struct MarketConfig {
        uint256 id;
        address asset;
        bytes32 feedId;
        uint256 imrWad;
        uint256 mmrWad;
        uint256 penaltyBps;
        uint256 maxFundingPerHourWad;
        uint256 takerFeeBps;
        uint256 maxOiUsdWad;
        uint256 maxPairSize;
        uint256 maxCloseSpreadBps;
    }

    struct Market {
        address asset;
        bytes32 feedId;
        uint256 scale;
        uint256 imrWad;
        uint256 mmrWad;
        uint256 penaltyBps;
        uint256 maxFundingPerHourWad;
        uint256 takerFeeBps;
        uint256 maxOiUsdWad;
        uint256 maxPairSize;
        uint256 maxCloseSpreadBps;
    }

    struct FundingState {
        uint256 index;
        uint256 lastEpoch;
        bytes32 head;
        uint256 consumed;
        /// @notice Bond the market has drawn so far. Public so the creator can get the rest back without operators (#24).
        uint256 bondUsed;
    }

    struct FundingPublic {
        uint256 market;
        bytes32 newHead;
        uint256 asOf;
        uint256 indexMag;
        uint256 indexNeg;
        uint256 claimRatio;
        bytes32[CT_MARKET][MARKET_KEYS] ciphertexts;
        uint256 bondUsedNext;
    }

    struct LockPublic {
        bytes32 root;
        bytes32[2] nullifiers;
        bytes32 changeCommitment;
        bytes32 lockCommitment;
        bytes32[CT_NOTE] changeCt;
        bytes32[CT_LOCK] ownerCt;
        bytes32[CT_LOCK] coordinatorCt;
        bytes32[CT_LOCK][2] riskCt;
        uint256 asOf;
        FeeOut relayFee;
    }

    struct OpenPublic {
        bytes32 root;
        bytes32[2] nullifiers;
        bytes32 pairCommitment;
        bytes32 refundCommitment;
        bytes32[CT_PAIR][PAIR_KEYS] pairCt;
        bytes32[CT_NOTE] refundCt;
        uint256 market;
        uint256 asOf;
        bytes32 deltaCommitment;
        bytes32 feeCommitment;
        bytes32[CT_NOTE] feeCt;
    }

    struct UpdatePublic {
        bytes32 root;
        bytes32[2] nullifiers;
        bytes32 pairCommitment;
        bytes32 outCommitment;
        bytes32 feeCommitment;
        bytes32[CT_PAIR][PAIR_KEYS] pairCt;
        bytes32[CT_NOTE] outCt;
        bytes32[CT_NOTE] feeCt;
        uint256 market;
        bytes32 deltaCommitment;
        bytes32 carriedNullifier;
        uint256 asOf;
        FeeOut relayFee;
    }

    struct LiquidatePublic {
        bytes32 root;
        bytes32 nullifier;
        bytes32[3] commitments;
        bytes32[CT_NOTE][3] ciphertexts;
        uint256 market;
        bytes32 deltaCommitment;
        bytes32 claimCommitment;
        bytes32[CT_CLAIM][CLAIM_KEYS] claimCt;
    }

    struct RedeemPublic {
        bytes32 root;
        bytes32 nullifier;
        bytes32 commitment;
        bytes32[CT_NOTE] ciphertext;
        bytes32 deltaCommitment;
        FeeOut relayFee;
    }

    struct SweepPublic {
        uint256 market;
        bytes32 newHead;
        bytes32 commitment;
        bytes32[CT_NOTE] ciphertext;
        bytes32[CT_MARKET][MARKET_KEYS] marketCt;
    }

    struct ClosePublic {
        bytes32 root;
        bytes32 nullifier;
        bytes32[3] commitments;
        bytes32[CT_NOTE][3] ciphertexts;
        uint256 market;
        bytes32 deltaCommitment;
        uint256 mode;
        FeeOut relayFee;
    }

    struct ExitRequest {
        address requester;
        uint64 matureAt;
    }

    struct ReleasePublic {
        bytes32 root;
        bytes32 nullifier;
        bytes32 commitment;
        bytes32[CT_NOTE] ciphertext;
        uint256 asOf;
        FeeOut relayFee;
    }

    struct EpochContext {
        bytes32 head;
        uint256 dt;
        uint256 mark;
        uint256 bond;
        uint256 bondUsed;
    }

    struct Modules {
        address spot;
        address markets;
        address registry;
    }

    /// @dev Everything fixed at deployment that public inputs need.
    struct Keys {
        uint256 deploymentId;
        uint256 coordinatorX;
        uint256 coordinatorY;
        uint256 riskAX;
        uint256 riskAY;
        uint256 riskBX;
        uint256 riskBY;
        uint256 feeAuth;
        uint256 feeX;
        uint256 feeY;
    }
}
