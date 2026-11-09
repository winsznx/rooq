// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IHonkVerifier} from "./ShieldedPool.sol";
import {PrivatePairs} from "./PrivatePairs.sol";

uint256 constant SPOT_CT_NOTE = 7;
uint256 constant SPOT_CT_LP = 12;
uint256 constant SPOT_CT_POOL = 7;
uint256 constant SPOT_LP_KEYS = 4;
uint256 constant SPOT_POOL_KEYS = 3;

/// @title PrivateSpot
/// @notice Private constant-product pools over the same custody and note tree as PrivatePairs (SPOT-01..06). Reserves and
///         share supply live in a private record per pool: the contract holds only its commitment. Tokens never move here,
///         so a swap has no public transfer. Pool ids, tokens and fees are fixed at deployment; there is no admin or pause.
/// @dev Public inputs are ordered exactly as the `pub` parameters of zk/circuits/{swap,lp_add,lp_set,lp_remove}/src/main.nr.
contract PrivateSpot is ReentrancyGuard {
    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint8 public constant RECORD_FREE = 1;
    uint8 public constant RECORD_LP = 5;

    struct PoolConfig {
        uint256 id;
        address token0;
        address token1;
        uint256 feeBps;
    }

    struct Pool {
        address token0;
        address token1;
        uint256 feeBps;
        bytes32 head;
    }

    struct Verifiers {
        IHonkVerifier swap;
        IHonkVerifier lpAdd;
        IHonkVerifier lpSet;
        IHonkVerifier lpRemove;
    }

    struct SwapPublic {
        bytes32 root;
        bytes32 nullifier;
        bytes32 outCommitment;
        bytes32[SPOT_CT_NOTE] outCt;
        uint256 asOf;
        uint256[2] pool;
        bytes32[2] newHead;
        bytes32[SPOT_CT_POOL][SPOT_POOL_KEYS][2] poolCt;
    }

    struct LpAddPublic {
        bytes32 root;
        bytes32[2] nullifiers;
        bytes32 newHead;
        bytes32 lpCommitment;
        bytes32[SPOT_CT_LP][SPOT_LP_KEYS] lpCt;
        bytes32[2] refundCommitments;
        bytes32[SPOT_CT_NOTE][2] refundCt;
        bytes32[SPOT_CT_POOL][SPOT_POOL_KEYS] poolCt;
        uint256 asOf;
        uint256 pool;
    }

    struct LpSetPublic {
        bytes32 root;
        bytes32 nullifier;
        bytes32 nextCommitment;
        bytes32[SPOT_CT_LP][SPOT_LP_KEYS] ct;
        uint256 asOf;
        uint256 mode;
    }

    struct LpRemovePublic {
        bytes32 root;
        bytes32 nullifier;
        bytes32 newHead;
        bytes32[2] outCommitments;
        bytes32[SPOT_CT_NOTE][2] outCt;
        bytes32[SPOT_CT_POOL][SPOT_POOL_KEYS] poolCt;
        uint256 asOf;
        uint256 pool;
    }

    PrivatePairs public immutable custody;
    IHonkVerifier public immutable swapVerifier;
    IHonkVerifier public immutable lpAddVerifier;
    IHonkVerifier public immutable lpSetVerifier;
    IHonkVerifier public immutable lpRemoveVerifier;
    uint256 public immutable deploymentId;

    mapping(uint256 => Pool) internal _pools;

    error BadPool(uint256 id);
    error UnknownPool(uint256 id);
    error StaleAsOf(uint256 asOf, uint256 timestamp);
    error UnknownRoot(bytes32 root);
    error InvalidProof();
    error NotAFieldElement();

    event PoolUpdated(uint256 indexed pool, bytes32 head, bytes32[] ciphertext);

    constructor(PrivatePairs custody_, Verifiers memory v, PoolConfig[] memory pools) {
        custody = custody_;
        swapVerifier = v.swap;
        lpAddVerifier = v.lpAdd;
        lpSetVerifier = v.lpSet;
        lpRemoveVerifier = v.lpRemove;
        deploymentId = custody_.deploymentId();
        for (uint256 i; i < pools.length; i++) {
            PoolConfig memory p = pools[i];
            bool badTokens = p.token0 == p.token1 || !custody_.isSupported(p.token0) || !custody_.isSupported(p.token1);
            if (p.id == 0 || p.id >= FIELD || badTokens || p.feeBps >= 10_000 || _pools[p.id].token0 != address(0)) revert BadPool(p.id);
            _pools[p.id] = Pool(p.token0, p.token1, p.feeBps, bytes32(0));
        }
    }

    function pool(uint256 id) external view returns (Pool memory) {
        return _pools[id];
    }

    /// @notice Executes a swap intent through one pool, or two when `pool[1]` is set. Anyone may submit a valid proof.
    function swap(bytes calldata proof, SwapPublic calldata p) external nonReentrant {
        if (p.asOf < block.timestamp) revert StaleAsOf(p.asOf, block.timestamp);
        Pool memory first = _known(p.pool[0]);
        Pool memory second;
        if (p.pool[1] != 0) second = _known(p.pool[1]);
        _requireRoot(p.root);
        custody.moduleConsume(p.nullifier);
        if (!swapVerifier.verify(proof, _swapInputs(p, first, second))) revert InvalidProof();

        _setHead(p.pool[0], p.newHead[0], p.poolCt[0]);
        if (p.pool[1] != 0) _setHead(p.pool[1], p.newHead[1], p.poolCt[1]);
        custody.moduleCreate(RECORD_FREE, p.outCommitment, _note(p.outCt));
    }

    /// @notice Adds liquidity from two locks. The first add to a pool seeds it.
    function addLiquidity(bytes calldata proof, LpAddPublic calldata p) external nonReentrant {
        if (p.asOf < block.timestamp) revert StaleAsOf(p.asOf, block.timestamp);
        Pool memory q = _known(p.pool);
        _requireRoot(p.root);
        custody.moduleConsume(p.nullifiers[0]);
        custody.moduleConsume(p.nullifiers[1]);
        if (!lpAddVerifier.verify(proof, _lpAddInputs(p, q))) revert InvalidProof();

        _setHead(p.pool, p.newHead, p.poolCt);
        custody.moduleCreate(RECORD_LP, p.lpCommitment, _lp(p.lpCt));
        custody.moduleCreate(RECORD_FREE, p.refundCommitments[0], _note(p.refundCt[0]));
        custody.moduleCreate(RECORD_FREE, p.refundCommitments[1], _note(p.refundCt[1]));
    }

    /// @notice Opens a removal request (owner proof) or returns an expired one to idle (no key).
    function setLiquidityRequest(bytes calldata proof, LpSetPublic calldata p) external nonReentrant {
        if (p.asOf > block.timestamp) revert StaleAsOf(p.asOf, block.timestamp);
        _requireRoot(p.root);
        custody.moduleConsume(p.nullifier);
        uint256 total = 3 + SPOT_LP_KEYS * SPOT_CT_LP + 3 + 2 * SPOT_POOL_KEYS;
        bytes32[] memory inputs = new bytes32[](total);
        uint256 k;
        inputs[k++] = p.root;
        inputs[k++] = _f(p.nullifier);
        inputs[k++] = _f(p.nextCommitment);
        k = _putLp(inputs, k, p.ct);
        inputs[k++] = bytes32(deploymentId);
        inputs[k++] = bytes32(p.asOf);
        inputs[k++] = bytes32(p.mode);
        _putKeys(inputs, k);
        if (!lpSetVerifier.verify(proof, inputs)) revert InvalidProof();
        custody.moduleCreate(RECORD_LP, p.nextCommitment, _lp(p.ct));
    }

    /// @notice Executes an open removal request. Works in every state: there is no pause and no oracle here.
    function removeLiquidity(bytes calldata proof, LpRemovePublic calldata p) external nonReentrant {
        if (p.asOf < block.timestamp) revert StaleAsOf(p.asOf, block.timestamp);
        Pool memory q = _known(p.pool);
        _requireRoot(p.root);
        custody.moduleConsume(p.nullifier);
        if (!lpRemoveVerifier.verify(proof, _lpRemoveInputs(p, q))) revert InvalidProof();

        _setHead(p.pool, p.newHead, p.poolCt);
        custody.moduleCreate(RECORD_FREE, p.outCommitments[0], _note(p.outCt[0]));
        custody.moduleCreate(RECORD_FREE, p.outCommitments[1], _note(p.outCt[1]));
    }

    function _swapInputs(SwapPublic calldata p, Pool memory first, Pool memory second) internal view returns (bytes32[] memory inputs) {
        inputs = new bytes32[](3 + SPOT_CT_NOTE + 2 + 12 + 2 * SPOT_POOL_KEYS * SPOT_CT_POOL + 2 * SPOT_POOL_KEYS);
        uint256 k;
        inputs[k++] = p.root;
        inputs[k++] = _f(p.nullifier);
        inputs[k++] = _f(p.outCommitment);
        for (uint256 i; i < SPOT_CT_NOTE; i++) inputs[k++] = _f(p.outCt[i]);
        inputs[k++] = bytes32(deploymentId);
        inputs[k++] = bytes32(p.asOf);
        inputs[k++] = bytes32(p.pool[0]);
        inputs[k++] = bytes32(p.pool[1]);
        inputs[k++] = _addr(first.token0);
        inputs[k++] = _addr(second.token0);
        inputs[k++] = _addr(first.token1);
        inputs[k++] = _addr(second.token1);
        inputs[k++] = bytes32(first.feeBps);
        inputs[k++] = bytes32(second.feeBps);
        inputs[k++] = first.head;
        inputs[k++] = second.head;
        inputs[k++] = _f(p.newHead[0]);
        inputs[k++] = _f(p.newHead[1]);
        for (uint256 h; h < 2; h++) k = _putPool(inputs, k, p.poolCt[h]);
        _putKeys(inputs, k);
    }

    function _lpAddInputs(LpAddPublic calldata p, Pool memory q) internal view returns (bytes32[] memory inputs) {
        inputs = new bytes32[](6 + SPOT_LP_KEYS * SPOT_CT_LP + 2 + 2 * SPOT_CT_NOTE + SPOT_POOL_KEYS * SPOT_CT_POOL + 5 + 2 * SPOT_POOL_KEYS);
        uint256 k;
        inputs[k++] = p.root;
        inputs[k++] = _f(p.nullifiers[0]);
        inputs[k++] = _f(p.nullifiers[1]);
        inputs[k++] = q.head;
        inputs[k++] = _f(p.newHead);
        inputs[k++] = _f(p.lpCommitment);
        k = _putLp(inputs, k, p.lpCt);
        inputs[k++] = _f(p.refundCommitments[0]);
        inputs[k++] = _f(p.refundCommitments[1]);
        for (uint256 i; i < 2; i++) {
            for (uint256 j; j < SPOT_CT_NOTE; j++) inputs[k++] = _f(p.refundCt[i][j]);
        }
        k = _putPool(inputs, k, p.poolCt);
        inputs[k++] = bytes32(deploymentId);
        inputs[k++] = bytes32(p.asOf);
        inputs[k++] = bytes32(p.pool);
        inputs[k++] = _addr(q.token0);
        inputs[k++] = _addr(q.token1);
        _putKeys(inputs, k);
    }

    function _lpRemoveInputs(LpRemovePublic calldata p, Pool memory q) internal view returns (bytes32[] memory inputs) {
        inputs = new bytes32[](4 + 2 + 2 * SPOT_CT_NOTE + SPOT_POOL_KEYS * SPOT_CT_POOL + 5 + 2 * SPOT_POOL_KEYS);
        uint256 k;
        inputs[k++] = p.root;
        inputs[k++] = _f(p.nullifier);
        inputs[k++] = q.head;
        inputs[k++] = _f(p.newHead);
        inputs[k++] = _f(p.outCommitments[0]);
        inputs[k++] = _f(p.outCommitments[1]);
        for (uint256 i; i < 2; i++) {
            for (uint256 j; j < SPOT_CT_NOTE; j++) inputs[k++] = _f(p.outCt[i][j]);
        }
        k = _putPool(inputs, k, p.poolCt);
        inputs[k++] = bytes32(deploymentId);
        inputs[k++] = bytes32(p.asOf);
        inputs[k++] = bytes32(p.pool);
        inputs[k++] = _addr(q.token0);
        inputs[k++] = _addr(q.token1);
        _putKeys(inputs, k);
    }

    /// @dev Read from custody on every call: keys rotate (D-24), and spot must encrypt pool state to the set in effect.
    function _putKeys(bytes32[] memory inputs, uint256 k) internal view {
        PrivatePairs c = custody;
        inputs[k++] = bytes32(c.coordinatorX());
        inputs[k++] = bytes32(c.coordinatorY());
        inputs[k++] = bytes32(c.riskAX());
        inputs[k++] = bytes32(c.riskAY());
        inputs[k++] = bytes32(c.riskBX());
        inputs[k] = bytes32(c.riskBY());
    }

    function _putPool(bytes32[] memory inputs, uint256 start, bytes32[SPOT_CT_POOL][SPOT_POOL_KEYS] calldata ct) internal pure returns (uint256 k) {
        k = start;
        for (uint256 i; i < SPOT_POOL_KEYS; i++) {
            for (uint256 j; j < SPOT_CT_POOL; j++) inputs[k++] = _f(ct[i][j]);
        }
    }

    function _putLp(bytes32[] memory inputs, uint256 start, bytes32[SPOT_CT_LP][SPOT_LP_KEYS] calldata ct) internal pure returns (uint256 k) {
        k = start;
        for (uint256 i; i < SPOT_LP_KEYS; i++) {
            for (uint256 j; j < SPOT_CT_LP; j++) inputs[k++] = _f(ct[i][j]);
        }
    }

    function _setHead(uint256 id, bytes32 head, bytes32[SPOT_CT_POOL][SPOT_POOL_KEYS] calldata ct) internal {
        _pools[id].head = head;
        bytes32[] memory flat = new bytes32[](SPOT_POOL_KEYS * SPOT_CT_POOL);
        for (uint256 i; i < SPOT_POOL_KEYS; i++) {
            for (uint256 j; j < SPOT_CT_POOL; j++) flat[i * SPOT_CT_POOL + j] = ct[i][j];
        }
        emit PoolUpdated(id, head, flat);
    }

    function _lp(bytes32[SPOT_CT_LP][SPOT_LP_KEYS] calldata ct) internal pure returns (bytes32[] memory flat) {
        flat = new bytes32[](SPOT_LP_KEYS * SPOT_CT_LP);
        for (uint256 i; i < SPOT_LP_KEYS; i++) {
            for (uint256 j; j < SPOT_CT_LP; j++) flat[i * SPOT_CT_LP + j] = ct[i][j];
        }
    }

    function _note(bytes32[SPOT_CT_NOTE] calldata ct) internal pure returns (bytes32[] memory flat) {
        flat = new bytes32[](SPOT_CT_NOTE);
        for (uint256 i; i < SPOT_CT_NOTE; i++) flat[i] = ct[i];
    }

    function _known(uint256 id) internal view returns (Pool memory p) {
        p = _pools[id];
        if (p.token0 == address(0)) revert UnknownPool(id);
    }

    function _requireRoot(bytes32 r) internal view {
        if (!custody.isKnownRoot(r)) revert UnknownRoot(r);
    }

    function _addr(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _f(bytes32 x) internal pure returns (bytes32) {
        if (uint256(x) >= FIELD) revert NotAFieldElement();
        return x;
    }
}
