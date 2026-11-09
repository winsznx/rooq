// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IHonkVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

/// @title ShieldedPool
/// @notice Custody of supported tokens behind a commitment tree of private FREE notes (ADR-P02).
///         Value enters with `shield`, moves privately with `spend`, and leaves only through a proven `spend`
///         that names the recipient. No admin, no sweep, no upgrade; verifiers and supported assets are fixed at
///         deployment.
/// @dev Public inputs are ordered exactly as the `pub` parameters of zk/circuits/{append,spend}/src/main.nr.
contract ShieldedPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant TREE_DEPTH = 32;
    uint256 public constant APPEND_BATCH = 8;
    uint256 public constant ROOT_HISTORY = 64;
    uint256 public constant NOTE_CT_LEN = 7;
    uint256 public constant MAX_AMOUNT = (1 << 100) - 1;
    /// @dev BN254 scalar field modulus. Every public input must be a canonical field element.
    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    /// @dev Root of the empty depth-32 Poseidon2 tree, printed by `nargo test` in zk/circuits/lib.
    bytes32 public constant EMPTY_ROOT = 0x3052b29bfb238050267b37af5f51263be92975eee9d79bddf056c3e9e84caa99;

    uint8 internal constant KIND_DEPOSIT = 1;
    uint8 internal constant KIND_LEAF = 2;

    IHonkVerifier public immutable appendVerifier;
    IHonkVerifier public immutable spendVerifier;
    /// @notice Binds every proof to this chain and this contract: (chainid << 160) | address(this).
    uint256 public immutable deploymentId;

    struct Entry {
        uint8 kind;
        bytes32 a;
        bytes32 b;
        bytes32 c;
    }

    struct SpendPublic {
        bytes32 root;
        bytes32[2] nullifiers;
        bytes32[3] commitments;
        bytes32[NOTE_CT_LEN][3] ciphertexts;
        address publicAsset;
        uint256 withdrawAmount;
        address withdrawRecipient;
        address relayer;
        uint256 relayerFee;
    }

    mapping(address => bool) public isSupported;
    Entry[] internal _queue;
    /// @notice Queue entries already in the tree. Entry i is leaf i.
    uint256 public processed;
    bytes32 public root;
    uint256 public rootSeq;
    mapping(bytes32 => uint256) public rootSeqOf;
    mapping(bytes32 => bool) public nullifierSpent;

    error UnsupportedAsset(address asset);
    error BadAmount();
    error NotAFieldElement();
    error TransferAmountMismatch(uint256 expected, uint256 received);
    error NothingQueued();
    error UnknownRoot(bytes32 root);
    error NullifierSpent(bytes32 nullifier);
    error InvalidProof();
    error TreeFull();

    event Shielded(uint256 indexed leafIndex, address indexed asset, uint256 amount, bytes32 inner, address indexed from);
    event NotesCreated(uint256 indexed firstLeafIndex, bytes32[3] commitments, bytes32[NOTE_CT_LEN][3] ciphertexts);
    event NullifiersSpent(bytes32[2] nullifiers);
    event Unshielded(address indexed asset, address indexed recipient, uint256 amount, address relayer, uint256 fee);
    event RootUpdated(bytes32 indexed root, uint256 indexed seq, uint256 firstLeafIndex, uint256 count);

    constructor(IHonkVerifier appendVerifier_, IHonkVerifier spendVerifier_, address[] memory assets) {
        appendVerifier = appendVerifier_;
        spendVerifier = spendVerifier_;
        deploymentId = (block.chainid << 160) | uint256(uint160(address(this)));
        for (uint256 i; i < assets.length; i++) {
            isSupported[assets[i]] = true;
        }
        root = EMPTY_ROOT;
        rootSeq = 1;
        rootSeqOf[EMPTY_ROOT] = 1;
    }

    /// @notice Moves `amount` of `asset` into the pool as a FREE note whose hiding part is `inner`.
    ///         Asset, amount and sender are public; the note owner is not.
    function shield(address asset, uint256 amount, bytes32 inner) external nonReentrant returns (uint256 leafIndex) {
        if (!isSupported[asset]) revert UnsupportedAsset(asset);
        if (amount == 0 || amount > MAX_AMOUNT) revert BadAmount();
        if (uint256(inner) >= FIELD) revert NotAFieldElement();
        IERC20 token = IERC20(asset);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != amount) revert TransferAmountMismatch(amount, received);
        leafIndex = _push(Entry(KIND_DEPOSIT, inner, bytes32(uint256(uint160(asset))), bytes32(amount)));
        emit Shielded(leafIndex, asset, amount, inner, msg.sender);
    }

    /// @notice Inserts the next queued entries into the tree. Permissionless: the proof needs no secrets.
    function processQueue(bytes calldata proof, bytes32 newRoot) external {
        uint256 start = processed;
        uint256 count = _queue.length - start;
        if (count == 0) revert NothingQueued();
        if (count > APPEND_BATCH) count = APPEND_BATCH;
        if (uint256(newRoot) >= FIELD) revert NotAFieldElement();

        bytes32[] memory inputs = new bytes32[](4 + 4 * APPEND_BATCH);
        inputs[0] = bytes32(deploymentId);
        inputs[1] = root;
        inputs[2] = newRoot;
        inputs[3] = bytes32(start);
        for (uint256 i; i < count; i++) {
            Entry storage e = _queue[start + i];
            inputs[4 + i] = bytes32(uint256(e.kind));
            inputs[4 + APPEND_BATCH + i] = e.a;
            inputs[4 + 2 * APPEND_BATCH + i] = e.b;
            inputs[4 + 3 * APPEND_BATCH + i] = e.c;
        }
        if (!appendVerifier.verify(proof, inputs)) revert InvalidProof();

        processed = start + count;
        root = newRoot;
        uint256 seq = ++rootSeq;
        rootSeqOf[newRoot] = seq;
        emit RootUpdated(newRoot, seq, start, count);
    }

    /// @notice Consumes two notes and creates three, optionally paying a withdrawal and a relayer fee in
    ///         `publicAsset`. Anyone may submit; the proof fixes every recipient and amount.
    function spend(bytes calldata proof, SpendPublic calldata p) external nonReentrant {
        if (!isKnownRoot(p.root)) revert UnknownRoot(p.root);
        for (uint256 i; i < 2; i++) {
            bytes32 nf = p.nullifiers[i];
            if (nullifierSpent[nf]) revert NullifierSpent(nf);
            nullifierSpent[nf] = true;
        }
        bool pays = p.withdrawAmount != 0 || p.relayerFee != 0;
        if (pays && !isSupported[p.publicAsset]) revert UnsupportedAsset(p.publicAsset);
        if (!spendVerifier.verify(proof, _spendInputs(p))) revert InvalidProof();

        uint256 first = _push(Entry(KIND_LEAF, p.commitments[0], 0, 0));
        _push(Entry(KIND_LEAF, p.commitments[1], 0, 0));
        _push(Entry(KIND_LEAF, p.commitments[2], 0, 0));
        emit NullifiersSpent(p.nullifiers);
        emit NotesCreated(first, p.commitments, p.ciphertexts);

        if (pays) {
            IERC20 token = IERC20(p.publicAsset);
            if (p.withdrawAmount != 0) token.safeTransfer(p.withdrawRecipient, p.withdrawAmount);
            if (p.relayerFee != 0) token.safeTransfer(p.relayer, p.relayerFee);
            emit Unshielded(p.publicAsset, p.withdrawRecipient, p.withdrawAmount, p.relayer, p.relayerFee);
        }
    }

    function isKnownRoot(bytes32 r) public view returns (bool) {
        uint256 seq = rootSeqOf[r];
        return seq != 0 && rootSeq - seq < ROOT_HISTORY;
    }

    function queueLength() external view returns (uint256) {
        return _queue.length;
    }

    function queueEntry(uint256 i) external view returns (Entry memory) {
        return _queue[i];
    }

    function _push(Entry memory e) internal returns (uint256 index) {
        index = _queue.length;
        if (index >= 1 << TREE_DEPTH) revert TreeFull();
        _queue.push(e);
    }

    function _spendInputs(SpendPublic calldata p) internal view returns (bytes32[] memory inputs) {
        inputs = new bytes32[](6 + 3 * NOTE_CT_LEN + 6);
        inputs[0] = p.root;
        inputs[1] = _field(p.nullifiers[0]);
        inputs[2] = _field(p.nullifiers[1]);
        inputs[3] = _field(p.commitments[0]);
        inputs[4] = _field(p.commitments[1]);
        inputs[5] = _field(p.commitments[2]);
        uint256 k = 6;
        for (uint256 i; i < 3; i++) {
            for (uint256 j; j < NOTE_CT_LEN; j++) {
                inputs[k++] = _field(p.ciphertexts[i][j]);
            }
        }
        inputs[k++] = bytes32(deploymentId);
        inputs[k++] = bytes32(uint256(uint160(p.publicAsset)));
        inputs[k++] = _field(bytes32(p.withdrawAmount));
        inputs[k++] = bytes32(uint256(uint160(p.withdrawRecipient)));
        inputs[k++] = bytes32(uint256(uint160(p.relayer)));
        inputs[k] = _field(bytes32(p.relayerFee));
    }

    /// @dev Rejects non-canonical encodings so one field value cannot appear as two distinct bytes32 keys
    ///      (two nullifier slots for one note).
    function _field(bytes32 x) internal pure returns (bytes32) {
        if (uint256(x) >= FIELD) revert NotAFieldElement();
        return x;
    }
}
