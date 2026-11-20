// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IHonkVerifier} from "./ShieldedPool.sol";
import {IPriceSource, PrivatePairs} from "./PrivatePairs.sol";
import {CT_MARKET, CT_NOTE, MARKET_KEYS, PairTypes} from "./PairTypes.sol";
import {PairInputs} from "./PairInputs.sol";

/// @notice The oracle functions market creation needs beyond price reads.
interface IFeedRegistry is IPriceSource {
    function isApproved(bytes32 feedId) external view returns (bool);
}

/// @title PrivateMarkets
/// @notice Permissionless private perp market creation (MARKET-01..03, D-22). A creator picks a risk tier fixed at deployment and an
///         approved oracle feed, and posts a bond that backs the market's shortfalls after its insurance. Creator identity and bond size are
///         public by policy; positions stay private. There is no admin over markets. A creator can only stop new positions and, once the
///         market is empty, take back what the market did not use.
/// @dev Also holds delayed operator key rotation (D-24), kept here because PrivatePairs has no room for it. `keyScheduler` (the
///      timelock) can schedule new coordinator and risk keys and close a genesis market to new positions; `keyCanceller` (a Safe)
///      can only withdraw a scheduled rotation. Neither can move funds, change a market's terms or touch a record. Every operator key,
///      and the fee key, comes with a key_pop proof that its holder has the secret (audit #18), bound to this deployment, the key
///      epoch it would start and its slot.
contract PrivateMarkets is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Tier {
        uint256 imrWad;
        uint256 mmrWad;
        uint256 maxOiUsdWad;
        uint256 takerFeeBps;
        uint256 penaltyBps;
        uint256 maxFundingPerHourWad;
        uint256 maxPairSize;
        uint256 minBond;
        uint256 maxCloseSpreadBps;
    }

    struct Created {
        address creator;
        uint256 bond;
        bool released;
    }

    uint256 public constant FIRST_MARKET_ID = 100;
    /// @notice Past this with no fresh price, a market with no positions may release its insurance (D-17).
    uint256 public constant INSURANCE_SWEEP_AFTER = 90 days;
    /// @notice How long a scheduled operator key change waits before it can take effect (D-24).
    uint256 public constant KEY_ROTATION_DELAY = 24 hours;
    /// @notice How long after close-only a creator can take back the unused bond without a proof (#24). Longer than a forced exit
    ///         (7 days) plus the dead-oracle wait (14 days), so every position has had its way out first.
    uint256 public constant BOND_FALLBACK_AFTER = 30 days;
    uint8 internal constant RECORD_FREE = 1;
    uint8 internal constant SLOT_COORDINATOR = 0;
    uint8 internal constant SLOT_RISK_A = 1;
    uint8 internal constant SLOT_RISK_B = 2;
    uint8 internal constant SLOT_FEE = 3;

    PrivatePairs public immutable custody;
    IHonkVerifier public immutable bondReleaseVerifier;
    IHonkVerifier public immutable redeemVerifier;
    IHonkVerifier public immutable sweepVerifier;
    IHonkVerifier public immutable popVerifier;
    address public immutable collateral;
    uint256 public immutable deploymentId;
    /// @notice Schedules operator key rotations and closes genesis markets. Changes that add risk wait out its delay first.
    address public immutable keyScheduler;
    /// @notice Withdraws a scheduled rotation. Instant, since it can only stop a change, never make one.
    address public immutable keyCanceller;
    uint256 public marketCount;
    /// @notice When the scheduled rotation can be activated. Zero means none is scheduled.
    uint256 public keyRotationActivatesAt;

    Tier[] internal _tiers;
    mapping(uint256 => Created) public created;
    /// @notice When a created market first went close-only. Zero while it takes new positions.
    mapping(uint256 => uint256) public closedAt;
    mapping(bytes32 => bool) public feedTaken;
    /// @notice Every key that has ever been in use. A retired key can never come back (D-24).
    mapping(bytes32 => bool) public keyUsed;
    PairTypes.KeySet internal _pendingKeys;
    /// @notice Key sets in the order they took effect. Index 0 is the set from deployment.
    PairTypes.KeySet[] internal _keyHistory;

    error UnknownTier(uint256 tier);
    error FeedNotApproved(bytes32 feedId);
    error FeedAlreadyUsed(bytes32 feedId);
    error BondTooSmall(uint256 bond, uint256 minimum);
    error OpenInterestAboveTier(uint256 requested, uint256 maximum);
    error PairSizeAboveOiShare(uint256 maxPairSizeUsdWad, uint256 maxOiUsdWad);
    error NotCreator(uint256 market);
    error MarketStillOpen(uint256 market);
    error BondAlreadyReleased(uint256 market);
    error InvalidProof();
    error ClaimNotFolded(bytes32 deltaCommitment);
    error MarketNotWoundDown(uint256 market);
    error UnknownRoot(bytes32 root);
    error NotKeyGuardian();
    error KeyRotationPending(uint256 activatesAt);
    error NoKeyRotationPending();
    error KeyRotationNotDue(uint256 activatesAt, uint256 timestamp);
    error KeyNotOnCurve(uint256 x, uint256 y);
    error KeyReused(uint256 x, uint256 y);
    error KeysNotDistinct();
    error NoKeyChange();
    error DuplicateGenesisFeed(bytes32 feedId);
    error GenesisIdCollides(uint256 id);
    error NotGenesisMarket(uint256 market);
    error MissingPossessionProof(uint8 slot);

    event MarketCreated(uint256 indexed market, address indexed creator, bytes32 feedId, uint256 tier, uint256 maxOiUsdWad, uint256 bond);
    event MarketClosedToNewPositions(uint256 indexed market);
    event BondReleased(uint256 indexed market, address indexed creator, uint256 returned, uint256 used);
    event BondReleasedWithoutProof(uint256 indexed market, address indexed creator, uint256 returned, uint256 used);
    event KeyRotationScheduled(uint256 activatesAt, PairTypes.KeySet keys);
    event KeyRotationCancelled(uint256 activatesAt);
    event KeyRotationActivated(uint256 indexed epoch, PairTypes.KeySet keys);

    struct Verifiers {
        IHonkVerifier bondRelease;
        IHonkVerifier redeem;
        IHonkVerifier sweep;
        IHonkVerifier pop;
    }

    /// @param genesisPops key_pop proofs for epoch 0, in slot order: coordinator, risk A, risk B, fee.
    constructor(
        PrivatePairs custody_,
        Verifiers memory v,
        address collateral_,
        Tier[] memory tiers,
        address keyScheduler_,
        address keyCanceller_,
        bytes[4] memory genesisPops
    ) {
        custody = custody_;
        bondReleaseVerifier = v.bondRelease;
        redeemVerifier = v.redeem;
        sweepVerifier = v.sweep;
        popVerifier = v.pop;
        collateral = collateral_;
        deploymentId = custody_.deploymentId();
        for (uint256 i; i < tiers.length; i++) _tiers.push(tiers[i]);
        keyScheduler = keyScheduler_;
        keyCanceller = keyCanceller_;
        // Genesis markets are registered by custody, so their feeds are found by scanning rather than trusted from a list.
        for (uint256 id = 1; id < FIRST_MARKET_ID; id++) {
            PairTypes.Market memory m = custody_.market(id);
            if (m.asset == address(0)) continue;
            if (feedTaken[m.feedId]) revert DuplicateGenesisFeed(m.feedId);
            feedTaken[m.feedId] = true;
        }
        // A genesis id here would make every createMarket revert in registerMarket.
        if (custody_.market(FIRST_MARKET_ID).asset != address(0)) revert GenesisIdCollides(FIRST_MARKET_ID);
        PairTypes.KeySet memory initial = PairTypes.KeySet(
            PairTypes.Point(custody_.coordinatorX(), custody_.coordinatorY()), PairTypes.Point(custody_.riskAX(), custody_.riskAY()), PairTypes.Point(custody_.riskBX(), custody_.riskBY())
        );
        _keyHistory.push(initial);
        _markKeysUsed(initial);
        // An operator key nobody holds stalls liquidation from block one, and a fee key nobody holds strands every fee.
        _requirePop(genesisPops[0], 0, SLOT_COORDINATOR, initial.coordinator);
        _requirePop(genesisPops[1], 0, SLOT_RISK_A, initial.riskA);
        _requirePop(genesisPops[2], 0, SLOT_RISK_B, initial.riskB);
        _requirePop(genesisPops[3], 0, SLOT_FEE, PairTypes.Point(custody_.feeX(), custody_.feeY()));
    }

    /// @notice Kept for readers of the single role this split from. Returns the scheduler.
    function keyGuardian() external view returns (address) {
        return keyScheduler;
    }

    function tier(uint256 id) external view returns (Tier memory) {
        return _tiers[id];
    }

    function tierCount() external view returns (uint256) {
        return _tiers.length;
    }

    /// @notice Creates a market on an approved, currently fresh feed. A feed can back only one market. The tier's largest pair, valued
    ///         at the current price, must fit ten times inside `maxOiUsdWad`, the rule the deploy script applies to genesis markets, so
    ///         one pair cannot fill the market's open interest.
    function createMarket(uint256 tierId, bytes32 feedId, uint256 maxOiUsdWad, uint256 bond) external nonReentrant returns (uint256 id) {
        if (tierId >= _tiers.length) revert UnknownTier(tierId);
        Tier memory t = _tiers[tierId];
        IFeedRegistry oracle = IFeedRegistry(address(custody.oracle()));
        if (!oracle.isApproved(feedId)) revert FeedNotApproved(feedId);
        uint256 price = oracle.getFreshPrice(feedId);
        if (feedTaken[feedId]) revert FeedAlreadyUsed(feedId);
        if (bond < t.minBond) revert BondTooSmall(bond, t.minBond);
        if (maxOiUsdWad == 0 || maxOiUsdWad > t.maxOiUsdWad) revert OpenInterestAboveTier(maxOiUsdWad, t.maxOiUsdWad);
        if (t.maxPairSize * price * 10 > maxOiUsdWad * 1e18) revert PairSizeAboveOiShare(t.maxPairSize * price / 1e18, maxOiUsdWad);

        id = FIRST_MARKET_ID + marketCount++;
        feedTaken[feedId] = true;
        created[id] = Created(msg.sender, bond, false);
        IERC20(collateral).safeTransferFrom(msg.sender, address(custody), bond);
        custody.registerMarket(
            PairTypes.MarketConfig(id, collateral, feedId, t.imrWad, t.mmrWad, t.penaltyBps, t.maxFundingPerHourWad, t.takerFeeBps, maxOiUsdWad, t.maxPairSize, t.maxCloseSpreadBps),
            bond
        );
        emit MarketCreated(id, msg.sender, feedId, tierId, maxOiUsdWad, bond);
    }

    /// @notice Stops new positions in the creator's market. Closing, liquidation and funding carry on.
    function closeToNewPositions(uint256 id) external {
        if (created[id].creator != msg.sender) revert NotCreator(id);
        if (closedAt[id] == 0) closedAt[id] = block.timestamp;
        custody.setCloseOnly(id);
        emit MarketClosedToNewPositions(id);
    }

    /// @notice Stops new positions in a market registered at deployment, which has no creator to do it. Closing, liquidation and
    ///         funding carry on (D-04).
    function closeGenesisMarket(uint256 id) external {
        if (msg.sender != keyScheduler) revert NotKeyGuardian();
        if (id >= FIRST_MARKET_ID || custody.market(id).asset == address(0)) revert NotGenesisMarket(id);
        custody.setCloseOnly(id);
        emit MarketClosedToNewPositions(id);
    }

    /// @notice Returns the unused bond once the market is closed and empty. Anyone can submit the proof; the money only goes to the creator.
    function releaseBond(bytes calldata proof, uint256 id, uint256 bondUsed) external nonReentrant {
        Created storage c = created[id];
        if (c.creator == address(0)) revert NotCreator(id);
        if (c.released) revert BondAlreadyReleased(id);
        PairTypes.FundingState memory st = custody.funding(id);
        if (!custody.closeOnly(id) || custody.oiDeltaCount(id) != st.consumed) revert MarketStillOpen(id);
        bytes32[] memory inputs = new bytes32[](4);
        inputs[0] = bytes32(deploymentId);
        inputs[1] = bytes32(id);
        inputs[2] = st.head;
        inputs[3] = bytes32(bondUsed);
        if (!bondReleaseVerifier.verify(proof, inputs)) revert InvalidProof();
        c.released = true;
        custody.payBond(id, c.creator, bondUsed);
        emit BondReleased(id, c.creator, c.bond - bondUsed, bondUsed);
    }

    /// @notice Returns the bond the public record says is unused, with no proof and no operator, once the market has been
    ///         close-only for BOND_FALLBACK_AFTER and every change is folded. Anyone may call; the money only goes to the creator.
    ///         Custody keeps exactly what was drawn, and later epochs see that as the whole bond, so they cannot draw more.
    function releaseBondAfterNotice(uint256 id) external nonReentrant {
        Created storage c = created[id];
        if (c.creator == address(0)) revert NotCreator(id);
        if (c.released) revert BondAlreadyReleased(id);
        PairTypes.FundingState memory st = custody.funding(id);
        uint256 closed = closedAt[id];
        if (closed == 0 || block.timestamp < closed + BOND_FALLBACK_AFTER || custody.oiDeltaCount(id) != st.consumed) revert MarketStillOpen(id);
        c.released = true;
        custody.payBond(id, c.creator, st.bondUsed);
        emit BondReleasedWithoutProof(id, c.creator, c.bond - st.bondUsed, st.bondUsed);
    }

    /// @notice Pays a claim at the ratio of the epoch that folded it. Anyone holding its plaintext may submit.
    function redeemClaim(bytes calldata proof, PairTypes.RedeemPublic calldata p) external nonReentrant {
        uint256 stored = custody.foldedRatioPlusOne(p.deltaCommitment);
        if (stored == 0) revert ClaimNotFolded(p.deltaCommitment);
        if (!custody.isKnownRoot(p.root)) revert UnknownRoot(p.root);
        custody.moduleConsume(p.nullifier);
        if (!redeemVerifier.verify(proof, PairInputs.redeem(p, _keys(), stored - 1))) revert InvalidProof();
        custody.moduleCreate(RECORD_FREE, p.commitment, _note(p.ciphertext));
        custody.moduleCreate(RECORD_FREE, p.relayFee.commitment, _note(p.relayFee.ct));
    }

    /// @notice Releases the insurance of a market that has ended: nothing pending, no positions (proved), oracle long dead.
    function sweepInsurance(bytes calldata proof, PairTypes.SweepPublic calldata p) external nonReentrant {
        PairTypes.Market memory m = custody.market(p.market);
        PairTypes.FundingState memory st = custody.funding(p.market);
        (, uint256 updatedAt, bool fresh) = IPriceSource(address(custody.oracle())).getPrice(m.feedId);
        uint256 seen = custody.lastFreshPrice(p.market);
        uint256 lastSeen = updatedAt > seen ? updatedAt : seen;
        if (fresh || lastSeen >= block.timestamp || block.timestamp - lastSeen < INSURANCE_SWEEP_AFTER || custody.oiDeltaCount(p.market) != st.consumed) {
            revert MarketNotWoundDown(p.market);
        }
        if (!sweepVerifier.verify(proof, PairInputs.sweep(p, m, _keys(), st.head))) revert InvalidProof();
        custody.moduleCreate(RECORD_FREE, p.commitment, _note(p.ciphertext));
        bytes32[] memory ct = new bytes32[](MARKET_KEYS * CT_MARKET);
        for (uint256 i; i < MARKET_KEYS; i++) {
            for (uint256 j; j < CT_MARKET; j++) ct[i * CT_MARKET + j] = p.marketCt[i][j];
        }
        custody.setSweptHead(p.market, p.newHead, ct);
    }

    /// @notice Schedules new operator keys, which can take effect after KEY_ROTATION_DELAY. A slot left unchanged keeps its key and
    ///         ignores its entry in `pops`; a changed slot needs a key_pop proof for the epoch this set would start.
    function scheduleKeyRotation(PairTypes.KeySet calldata next, bytes[3] calldata pops) external {
        if (msg.sender != keyScheduler) revert NotKeyGuardian();
        if (keyRotationActivatesAt != 0) revert KeyRotationPending(keyRotationActivatesAt);
        uint256 epoch = _keyHistory.length;
        PairTypes.KeySet memory current = _keyHistory[epoch - 1];
        bool changed;
        if (_validateSlot(next.coordinator, current.coordinator)) {
            _requirePop(pops[0], epoch, SLOT_COORDINATOR, next.coordinator);
            changed = true;
        }
        if (_validateSlot(next.riskA, current.riskA)) {
            _requirePop(pops[1], epoch, SLOT_RISK_A, next.riskA);
            changed = true;
        }
        if (_validateSlot(next.riskB, current.riskB)) {
            _requirePop(pops[2], epoch, SLOT_RISK_B, next.riskB);
            changed = true;
        }
        if (!changed) revert NoKeyChange();
        if (_same(next.coordinator, next.riskA) || _same(next.coordinator, next.riskB) || _same(next.riskA, next.riskB)) revert KeysNotDistinct();
        _pendingKeys = next;
        keyRotationActivatesAt = block.timestamp + KEY_ROTATION_DELAY;
        emit KeyRotationScheduled(keyRotationActivatesAt, next);
    }

    /// @notice Withdraws a scheduled rotation, for example one that named a key nobody holds.
    function cancelKeyRotation() external {
        if (msg.sender != keyCanceller) revert NotKeyGuardian();
        uint256 activatesAt = keyRotationActivatesAt;
        if (activatesAt == 0) revert NoKeyRotationPending();
        delete keyRotationActivatesAt;
        delete _pendingKeys;
        emit KeyRotationCancelled(activatesAt);
    }

    /// @notice Puts the scheduled keys into effect once the delay has passed. Anyone may call it.
    function activateKeyRotation() external {
        uint256 activatesAt = keyRotationActivatesAt;
        if (activatesAt == 0) revert NoKeyRotationPending();
        if (block.timestamp < activatesAt) revert KeyRotationNotDue(activatesAt, block.timestamp);
        PairTypes.KeySet memory next = _pendingKeys;
        delete keyRotationActivatesAt;
        delete _pendingKeys;
        _keyHistory.push(next);
        _markKeysUsed(next);
        custody.setOperatorKeys(next);
        emit KeyRotationActivated(_keyHistory.length - 1, next);
    }

    function pendingKeyRotation() external view returns (uint256 activatesAt, PairTypes.KeySet memory keys) {
        return (keyRotationActivatesAt, _pendingKeys);
    }

    /// @notice Number of key changes that have taken effect since deployment.
    function keyEpoch() external view returns (uint256) {
        return _keyHistory.length - 1;
    }

    function keySetAt(uint256 epoch) external view returns (PairTypes.KeySet memory) {
        return _keyHistory[epoch];
    }

    /// @dev Returns whether this slot changes. A changed slot must be a valid Grumpkin point that has never been used: a wrong point would
    ///      make every proof that encrypts to it unsatisfiable, including liquidation.
    function _validateSlot(PairTypes.Point calldata next, PairTypes.Point memory current) internal view returns (bool) {
        if (next.x == current.x && next.y == current.y) return false;
        if (!PairInputs.onCurve(next.x, next.y)) revert KeyNotOnCurve(next.x, next.y);
        if (keyUsed[_keyId(next.x, next.y)]) revert KeyReused(next.x, next.y);
        return true;
    }

    /// @dev The verifier reverts on a malformed proof; that and a refused proof are the same failure here.
    function _requirePop(bytes memory proof, uint256 epoch, uint8 slot, PairTypes.Point memory k) internal view {
        bytes32[] memory inputs = new bytes32[](5);
        inputs[0] = bytes32(deploymentId);
        inputs[1] = bytes32(epoch);
        inputs[2] = bytes32(uint256(slot));
        inputs[3] = bytes32(k.x);
        inputs[4] = bytes32(k.y);
        bool held;
        try popVerifier.verify(proof, inputs) returns (bool ok) {
            held = ok;
        } catch {
            held = false;
        }
        if (!held) revert MissingPossessionProof(slot);
    }

    function _markKeysUsed(PairTypes.KeySet memory k) internal {
        keyUsed[_keyId(k.coordinator.x, k.coordinator.y)] = true;
        keyUsed[_keyId(k.riskA.x, k.riskA.y)] = true;
        keyUsed[_keyId(k.riskB.x, k.riskB.y)] = true;
    }

    function _keyId(uint256 x, uint256 y) internal pure returns (bytes32) {
        return keccak256(abi.encode(x, y));
    }

    function _same(PairTypes.Point calldata a, PairTypes.Point calldata b) internal pure returns (bool) {
        return a.x == b.x && a.y == b.y;
    }

    function _note(bytes32[CT_NOTE] calldata ct) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](CT_NOTE);
        for (uint256 i; i < CT_NOTE; i++) out[i] = ct[i];
    }

    function _keys() internal view returns (PairTypes.Keys memory) {
        PrivatePairs c = custody;
        return PairTypes.Keys(deploymentId, c.coordinatorX(), c.coordinatorY(), c.riskAX(), c.riskAY(), c.riskBX(), c.riskBY(), c.feeAuth(), c.feeX(), c.feeY());
    }
}
