// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IHonkVerifier, ShieldedPool} from "./ShieldedPool.sol";
import {PairInputs} from "./PairInputs.sol";
import {CLAIM_KEYS, CT_CLAIM, PairTypes} from "./PairTypes.sol";

interface IPriceSource {
    function getFreshPrice(bytes32 feedId) external view returns (uint256);
    function getPrice(bytes32 feedId) external view returns (uint256 priceWad, uint256 updatedAt, bool fresh);
}

/// @title PrivatePairs
/// @notice W2 prototype of private isolated pairs on top of ShieldedPool (ADR-P05): escrow locks, coordinator
///         matching, epoch funding over private open interest, and forced liquidation that needs neither trader
///         online.
/// @dev The contract, not the prover, supplies every economic parameter: oracle mark, market risk fractions, risk
///      keys (current set, see D-24), insurance balance, funding index and time. Public inputs are ordered exactly as the `pub` parameters of
///      zk/circuits/{lock,open_pair,liquidate,release,funding_epoch}/src/main.nr.
///      Perps only: spot and LP are separate work.
contract PrivatePairs is ShieldedPool, PairTypes {
    using SafeERC20 for IERC20;

    uint256 internal constant LOCK_CT_LEN = 15;
    uint256 internal constant PAIR_CT_LEN = 22;
    uint256 internal constant PAIR_RECIPIENTS = 4;
    uint256 internal constant MARKET_CT_LEN = 8;
    uint256 internal constant MARKET_CT_RECIPIENTS = 3;
    uint256 internal constant OI_BATCH = 8;
    /// @notice Funding indices are offset-encoded so circuits only see non-negative values.
    uint256 public constant FUNDING_INDEX_ZERO = 1 << 128;
    /// @notice A stalled market accrues at most this much funding in one epoch (ADR-P09 D3).
    uint256 internal constant MAX_FUNDING_WINDOW = 1 hours;
    /// @notice New exposure is refused once funding is older than this (LIQ-08). Liquidation is not.
    uint256 internal constant MAX_FUNDING_STALENESS = 1 hours;
    /// @notice An epoch must be stamped close to now, so a stall earns exactly one capped window.
    uint256 internal constant MAX_EPOCH_SKEW = 5 minutes;
    /// @notice How long an owner-proved exit request waits before it can force a close (D-11).
    uint256 internal constant EXIT_DELAY = 7 days;
    /// @notice Refundable anti-spam deposit for an exit request.
    uint256 public constant EXIT_BOND = 0.001 ether;
    /// @notice Past this with no fresh price, a matured exit may settle at the entry price (REC-05).
    uint256 internal constant ORACLE_DEAD_AFTER = 14 days;

    uint256 internal constant CLOSE_TAKER = 0;
    uint256 internal constant CLOSE_MATURED = 1;
    uint256 internal constant CLOSE_DEAD_ORACLE = 2;

    uint8 internal constant RECORD_FREE = 1;
    uint8 internal constant RECORD_LOCK = 2;
    uint8 internal constant RECORD_PAIR = 3;
    uint8 internal constant RECORD_CLAIM = 4;

    IHonkVerifier public immutable lockVerifier;
    IHonkVerifier public immutable openVerifier;
    IHonkVerifier public immutable liquidateVerifier;
    IHonkVerifier public immutable releaseVerifier;
    IHonkVerifier public immutable fundingEpochVerifier;
    IHonkVerifier public immutable closeVerifier;
    IHonkVerifier public immutable exitRequestVerifier;
    IHonkVerifier public immutable updateVerifier;
    uint256 public immutable feeAuth;
    uint256 public immutable feeX;
    uint256 public immutable feeY;
    IPriceSource public immutable oracle;
    /// @notice Operator keys. They change only through the markets module's delayed rotation (D-24).
    uint256 public coordinatorX;
    uint256 public coordinatorY;
    uint256 public riskAX;
    uint256 public riskAY;
    uint256 public riskBX;
    uint256 public riskBY;

    /// @notice The only contract allowed to consume records and add leaves on this tree, fixed at deployment.
    address public immutable spotModule;
    /// @notice The only contract allowed to add markets, close them to new positions and return creator bonds.
    address public immutable marketsModule;

    mapping(uint256 => uint256) public marketBond;
    mapping(uint256 => bool) public closeOnly;
    mapping(uint256 => Market) internal _markets;
    /// @notice Claim ratio of the epoch that folded a market-state change, plus one. Zero means not folded yet.
    mapping(bytes32 => uint256) public foldedRatioPlusOne;
    mapping(uint256 => FundingState) internal _funding;
    mapping(uint256 => bytes32[]) internal _oiDeltas;
    /// @notice Last time this contract saw a fresh price for a market. Bounds the dead-oracle timer.
    mapping(uint256 => uint256) public lastFreshPrice;
    /// @notice Exit requests by pair nullifier. A deadline never moves once set.
    mapping(bytes32 => ExitRequest) public exitRequests;
    mapping(address => uint256) public bondBalance;

    error NotSpotModule();
    error NotModule();
    error MarketCloseOnly(uint256 market);
    error UnknownMarket(uint256 market);
    error BadMarketConfig(uint256 market);
    error BadKey();
    error StaleAsOf(uint256 asOf, uint256 timestamp);
    error FundingStale(uint256 lastEpoch, uint256 timestamp);
    error BadBond();
    error ExitNotCarried(bytes32 nullifier);
    error ExitAlreadyRequested(bytes32 nullifier);
    error ExitNotMature(bytes32 nullifier);
    error OracleUnavailable(uint256 market);
    error OracleNotDead(uint256 market);
    error BadCloseMode(uint256 mode);
    error PairStillLive(bytes32 nullifier);
    error NoBond();
    error BondTransferFailed();

    event RecordCreated(uint256 indexed leafIndex, uint8 indexed kind, bytes32 commitment, bytes32[] ciphertext);
    event RecordsConsumed(bytes32[] nullifiers);
    event PairOpened(uint256 indexed market, bytes32 commitment);
    event FundingAdvanced(
        uint256 indexed market, uint256 index, uint256 asOf, uint256 dt, uint256 mark, bytes32 head, uint256 consumed, bytes32[] ciphertext
    );
    event ExitRequested(bytes32 indexed nullifier, address indexed requester, uint256 matureAt);
    event PairClosed(uint256 indexed market, bytes32 nullifier, uint256 mode, uint256 mark);
    event PairLiquidated(
        uint256 indexed market,
        bytes32 nullifier,
        uint256 mark
    );

    constructor(
        IHonkVerifier appendVerifier_,
        IHonkVerifier spendVerifier_,
        address[] memory assets,
        Verifiers memory v,
        IPriceSource oracle_,
        Point memory coordinator,
        Point[2] memory risk,
        FeeRecipient memory feeTo,
        MarketConfig[] memory markets,
        Modules memory modules
    ) ShieldedPool(appendVerifier_, spendVerifier_, assets) {
        if (coordinator.x == 0 || risk[0].x == 0 || risk[1].x == 0 || feeTo.key.x == 0) revert BadKey();
        if (risk[0].x == risk[1].x && risk[0].y == risk[1].y) revert BadKey();
        lockVerifier = v.lock;
        openVerifier = v.openPair;
        liquidateVerifier = v.liquidate;
        releaseVerifier = v.release;
        fundingEpochVerifier = v.fundingEpoch;
        closeVerifier = v.closePair;
        exitRequestVerifier = v.exitRequest;
        updateVerifier = v.pairUpdate;
        feeAuth = feeTo.auth;
        feeX = feeTo.key.x;
        feeY = feeTo.key.y;
        oracle = oracle_;
        spotModule = modules.spot;
        marketsModule = modules.markets;
        coordinatorX = coordinator.x;
        coordinatorY = coordinator.y;
        riskAX = risk[0].x;
        riskAY = risk[0].y;
        riskBX = risk[1].x;
        riskBY = risk[1].y;
        for (uint256 i; i < markets.length; i++) {
            _register(markets[i]);
        }
    }

    function _register(MarketConfig memory m) internal {
        if (m.id == 0 || m.id >= FIELD || !isSupported[m.asset] || _markets[m.id].asset != address(0)) revert BadMarketConfig(m.id);
        if (m.mmrWad == 0 || m.imrWad <= m.mmrWad || m.imrWad > 1e18 || m.penaltyBps > 10_000 || m.takerFeeBps > 10_000 || m.maxPairSize == 0) {
            revert BadMarketConfig(m.id);
        }
        uint256 scale = 10 ** (18 - IERC20Metadata(m.asset).decimals());
        _markets[m.id] = Market(m.asset, m.feedId, scale, m.imrWad, m.mmrWad, m.penaltyBps, m.maxFundingPerHourWad, m.takerFeeBps, m.maxOiUsdWad, m.maxPairSize);
        _funding[m.id] = FundingState(FUNDING_INDEX_ZERO, block.timestamp, bytes32(0), 0);
        lastFreshPrice[m.id] = block.timestamp;
    }

    /// @notice Adds a market created through the markets module, with its creator bond already held here.
    function registerMarket(MarketConfig calldata m, uint256 bond) external {
        if (msg.sender != marketsModule) revert NotModule();
        _register(m);
        marketBond[m.id] = bond;
    }

    /// @notice Records a market's next private state after its insurance is swept.
    function setSweptHead(uint256 id, bytes32 head, bytes32[] calldata ct) external {
        if (msg.sender != marketsModule) revert NotModule();
        FundingState storage st = _funding[id];
        st.head = head;
        emit FundingAdvanced(id, st.index, block.timestamp, 0, 0, head, st.consumed, ct);
    }

    /// @notice Stops new positions. Everything else keeps working (D-04).
    function setCloseOnly(uint256 id) external {
        if (msg.sender != marketsModule) revert NotModule();
        closeOnly[id] = true;
    }

    /// @notice Applies a key rotation that has waited out its delay in the markets module (D-24).
    function setOperatorKeys(KeySet calldata k) external {
        if (msg.sender != marketsModule) revert NotModule();
        (coordinatorX, coordinatorY) = (k.coordinator.x, k.coordinator.y);
        (riskAX, riskAY) = (k.riskA.x, k.riskA.y);
        (riskBX, riskBY) = (k.riskB.x, k.riskB.y);
    }

    /// @notice Pays out what is left of a released bond.
    function payBond(uint256 id, address to, uint256 used) external {
        if (msg.sender != marketsModule) revert NotModule();
        uint256 amount = marketBond[id] - used;
        marketBond[id] = used;
        IERC20(_markets[id].asset).safeTransfer(to, amount);
    }

    /// @notice Lets the spot module share this custody and tree. Tokens never move through it.
    function moduleConsume(bytes32 nf) external {
        if (msg.sender != spotModule && msg.sender != marketsModule) revert NotSpotModule();
        _consume(_field(nf));
        _emitConsumed(nf);
    }

    function moduleCreate(uint8 kind, bytes32 commitment, bytes32[] calldata ciphertext) external {
        if (msg.sender != spotModule && msg.sender != marketsModule) revert NotSpotModule();
        _create(kind, _field(commitment), ciphertext);
    }

    function market(uint256 id) external view returns (Market memory) {
        return _markets[id];
    }

    function funding(uint256 id) external view returns (FundingState memory) {
        return _funding[id];
    }

    function oiDeltaCount(uint256 id) external view returns (uint256) {
        return _oiDeltas[id].length;
    }

    function oiDelta(uint256 id, uint256 i) external view returns (bytes32) {
        return _oiDeltas[id][i];
    }

    /// @notice Folds the oldest pending open-interest changes and accrues this epoch's funding. Anyone may submit.
    ///         The count is computed here, so a prover cannot leave changes out to steer the rate. With a stale
    ///         oracle the clock advances without accruing, as the legacy engine does.
    function advanceFunding(bytes calldata proof, FundingPublic calldata p) external nonReentrant {
        Market memory m = _market(p.market);
        FundingState storage st = _funding[p.market];
        if (p.asOf <= st.lastEpoch || p.asOf > block.timestamp || p.asOf + MAX_EPOCH_SKEW < block.timestamp) {
            revert StaleAsOf(p.asOf, block.timestamp);
        }
        uint256 pending = _oiDeltas[p.market].length - st.consumed;
        uint256 count = pending > OI_BATCH ? OI_BATCH : pending;
        uint256 dt = p.asOf - st.lastEpoch;
        if (dt > MAX_FUNDING_WINDOW) dt = MAX_FUNDING_WINDOW;
        uint256 mark;
        try oracle.getFreshPrice(m.feedId) returns (uint256 price) {
            mark = price;
            lastFreshPrice[p.market] = block.timestamp;
        } catch {
            dt = 0;
        }

        bytes32[] memory deltas = new bytes32[](count);
        for (uint256 i; i < count; i++) deltas[i] = _oiDeltas[p.market][st.consumed + i];
        _verifyEpoch(proof, p, m, deltas, dt, mark);

        for (uint256 i; i < count; i++) foldedRatioPlusOne[deltas[i]] = p.claimRatio + 1;
        st.index = p.indexNeg == 0 ? st.index + p.indexMag : st.index - p.indexMag;
        st.lastEpoch = p.asOf;
        st.head = p.newHead;
        st.consumed += count;

        bytes32[] memory ct = new bytes32[](MARKET_CT_RECIPIENTS * MARKET_CT_LEN);
        for (uint256 i; i < MARKET_CT_RECIPIENTS; i++) {
            for (uint256 j; j < MARKET_CT_LEN; j++) ct[i * MARKET_CT_LEN + j] = p.ciphertexts[i][j];
        }
        emit FundingAdvanced(p.market, st.index, p.asOf, dt, mark, p.newHead, st.consumed, ct);
    }

    /// @notice Escrows FREE notes into a LOCK carrying trade terms. Proved by the owner's wallet.
    function lock(bytes calldata proof, LockPublic calldata p) external nonReentrant {
        _requireRoot(p.root);
        _consume(p.nullifiers[0]);
        _consume(p.nullifiers[1]);

        if (!lockVerifier.verify(proof, PairInputs.lock(p, _keys()))) revert InvalidProof();

        bytes32[] memory nfs = new bytes32[](2);
        nfs[0] = p.nullifiers[0];
        nfs[1] = p.nullifiers[1];
        emit RecordsConsumed(nfs);
        _create(RECORD_FREE, p.changeCommitment, _copy(p.changeCt));

        bytes32[] memory lockCt = new bytes32[](4 * LOCK_CT_LEN);
        for (uint256 i; i < LOCK_CT_LEN; i++) {
            lockCt[i] = p.ownerCt[i];
            lockCt[LOCK_CT_LEN + i] = p.coordinatorCt[i];
            lockCt[2 * LOCK_CT_LEN + i] = p.riskCt[0][i];
            lockCt[3 * LOCK_CT_LEN + i] = p.riskCt[1][i];
        }
        _create(RECORD_LOCK, p.lockCommitment, lockCt);
    }

    /// @notice Refunds an expired lock to its committed owner.
    function release(bytes calldata proof, ReleasePublic calldata p) external nonReentrant {
        if (p.asOf > block.timestamp) revert StaleAsOf(p.asOf, block.timestamp);
        _requireRoot(p.root);
        _consume(p.nullifier);

        if (!releaseVerifier.verify(proof, PairInputs.release(p, _keys()))) revert InvalidProof();

        _emitConsumed(p.nullifier);
        _create(RECORD_FREE, p.commitment, _copy(p.ciphertext));
    }

    /// @notice Matches two locks into a pair at the current oracle mark. `asOf` must not be in the past, so a
    ///         lock is never consumed after its expiry.
    function openPair(bytes calldata proof, OpenPublic calldata p) external nonReentrant {
        if (p.asOf < block.timestamp) revert StaleAsOf(p.asOf, block.timestamp);
        Market memory m = _market(p.market);
        FundingState storage st = _funding[p.market];
        if (closeOnly[p.market]) revert MarketCloseOnly(p.market);
        if (block.timestamp - st.lastEpoch > MAX_FUNDING_STALENESS) revert FundingStale(st.lastEpoch, block.timestamp);
        _requireRoot(p.root);
        _consume(p.nullifiers[0]);
        _consume(p.nullifiers[1]);
        uint256 mark = oracle.getFreshPrice(m.feedId);
        lastFreshPrice[p.market] = block.timestamp;
        // Every unfolded change counts as a maximum-size open, so the limit can only be conservative.
        uint256 pending = (_oiDeltas[p.market].length - st.consumed) * m.maxPairSize;
        if (!openVerifier.verify(proof, PairInputs.open(p, m, _keys(), mark, st.index, st.head, pending))) revert InvalidProof();
        _oiDeltas[p.market].push(_field(p.deltaCommitment));

        bytes32[] memory nfs = new bytes32[](2);
        nfs[0] = p.nullifiers[0];
        nfs[1] = p.nullifiers[1];
        emit RecordsConsumed(nfs);

        _create(RECORD_PAIR, p.pairCommitment, _flattenPair(p.pairCt));
        _create(RECORD_FREE, p.refundCommitment, _copy(p.refundCt));
        _create(RECORD_FREE, p.feeCommitment, _copy(p.feeCt));
        emit PairOpened(p.market, p.pairCommitment);
    }

    /// @notice Force-closes an unhealthy pair. Anyone may submit; finding a hidden pair needs a risk key, and the
    ///         proof fixes every payout.
    function liquidate(bytes calldata proof, LiquidatePublic calldata p) external nonReentrant {
        Market memory m = _market(p.market);
        _requireRoot(p.root);
        _consume(p.nullifier);
        uint256 mark = oracle.getFreshPrice(m.feedId);
        lastFreshPrice[p.market] = block.timestamp;
        if (!liquidateVerifier.verify(proof, PairInputs.liquidate(p, m, _keys(), mark, _funding[p.market].index))) revert InvalidProof();

        _emitConsumed(p.nullifier);
        _oiDeltas[p.market].push(_field(p.deltaCommitment));
        for (uint256 i; i < 3; i++) {
            _create(RECORD_FREE, p.commitments[i], _copy(p.ciphertexts[i]));
        }
        bytes32[] memory claimCt = new bytes32[](CLAIM_KEYS * CT_CLAIM);
        for (uint256 i; i < CLAIM_KEYS; i++) {
            for (uint256 j; j < CT_CLAIM; j++) claimCt[i * CT_CLAIM + j] = p.claimCt[i][j];
        }
        _create(RECORD_CLAIM, p.claimCommitment, claimCt);
        emit PairLiquidated(p.market, p.nullifier, mark);
    }

    /// @notice Replaces a live pair with its next version: funding, margin changes or a partial reduce. Without a fresh
    ///         price the mark is 0, which the circuit accepts only for adding margin and settling funding.
    function updatePair(bytes calldata proof, UpdatePublic calldata p) external nonReentrant {
        Market memory m = _market(p.market);
        _requireRoot(p.root);
        _consume(p.nullifiers[0]);
        _consume(p.nullifiers[1]);
        (uint256 price,, bool fresh) = oracle.getPrice(m.feedId);
        uint256 mark = fresh ? price : 0;
        if (fresh) lastFreshPrice[p.market] = block.timestamp;
        _verifyUpdate(proof, p, m, mark);
        // A pending exit follows the pair to its next version, keeping its requester and original deadline.
        ExitRequest memory pending = exitRequests[p.nullifiers[0]];
        if (pending.matureAt != 0) {
            if (p.carriedNullifier == 0) revert ExitNotCarried(p.nullifiers[0]);
            delete exitRequests[p.nullifiers[0]];
            exitRequests[p.carriedNullifier] = pending;
            emit ExitRequested(p.carriedNullifier, pending.requester, pending.matureAt);
        }

        bytes32[] memory nfs = new bytes32[](2);
        nfs[0] = p.nullifiers[0];
        nfs[1] = p.nullifiers[1];
        emit RecordsConsumed(nfs);
        _oiDeltas[p.market].push(_field(p.deltaCommitment));
        _create(RECORD_PAIR, p.pairCommitment, _flattenPair(p.pairCt));
        _create(RECORD_FREE, p.outCommitment, _copy(p.outCt));
        _create(RECORD_FREE, p.feeCommitment, _copy(p.feeCt));
    }

    /// @notice Starts a forced exit for a live pair the caller's proof shows it owns one side of. Anyone may relay it.
    function requestExit(bytes calldata proof, bytes32 root_, bytes32 nullifier) external payable nonReentrant {
        if (msg.value != EXIT_BOND) revert BadBond();
        _requireRoot(root_);
        if (nullifierSpent[nullifier]) revert NullifierSpent(nullifier);
        if (exitRequests[nullifier].requester != address(0)) revert ExitAlreadyRequested(nullifier);
        bytes32[] memory inputs = new bytes32[](3);
        inputs[0] = root_;
        inputs[1] = _field(nullifier);
        inputs[2] = bytes32(deploymentId);
        if (!exitRequestVerifier.verify(proof, inputs)) revert InvalidProof();
        uint64 matureAt = uint64(block.timestamp + EXIT_DELAY);
        exitRequests[nullifier] = ExitRequest(msg.sender, matureAt);
        emit ExitRequested(nullifier, msg.sender, matureAt);
    }

    /// @notice Closes a whole pair without penalty. See zk/circuits/close_pair for the three modes. Works in every
    ///         market state (D-04).
    function closePair(bytes calldata proof, ClosePublic calldata p) external nonReentrant {
        Market memory m = _market(p.market);
        _requireRoot(p.root);
        _consume(p.nullifier);
        uint256 mark = _closeMark(p, m);
        if (!closeVerifier.verify(proof, PairInputs.close(p, m, _keys(), mark, _funding[p.market].index))) revert InvalidProof();

        _emitConsumed(p.nullifier);
        _oiDeltas[p.market].push(_field(p.deltaCommitment));
        for (uint256 i; i < 3; i++) {
            _create(RECORD_FREE, p.commitments[i], _copy(p.ciphertexts[i]));
        }
        _creditBond(p.nullifier);
        emit PairClosed(p.market, p.nullifier, p.mode, mark);
    }

    /// @notice Returns the deposit of a request whose pair was consumed some other way, such as liquidation.
    function reclaimExitBond(bytes32 nullifier) external {
        if (!nullifierSpent[nullifier]) revert PairStillLive(nullifier);
        _creditBond(nullifier);
    }

    function withdrawBond() external nonReentrant {
        uint256 amount = bondBalance[msg.sender];
        if (amount == 0) revert NoBond();
        bondBalance[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert BondTransferFailed();
    }

    function _creditBond(bytes32 nullifier) internal {
        address requester = exitRequests[nullifier].requester;
        if (requester != address(0)) {
            delete exitRequests[nullifier].requester;
            bondBalance[requester] += EXIT_BOND;
        }
    }

    function _closeMark(ClosePublic calldata p, Market memory m) internal returns (uint256 mark) {
        (uint256 price, uint256 updatedAt, bool fresh) = oracle.getPrice(m.feedId);
        if (fresh) lastFreshPrice[p.market] = block.timestamp;
        if (p.mode == CLOSE_TAKER) {
            if (!fresh) revert OracleUnavailable(p.market);
            return price;
        }
        ExitRequest memory r = exitRequests[p.nullifier];
        if (r.matureAt == 0 || block.timestamp < r.matureAt) revert ExitNotMature(p.nullifier);
        if (p.mode == CLOSE_MATURED) {
            if (!fresh) revert OracleUnavailable(p.market);
            return price;
        }
        if (p.mode != CLOSE_DEAD_ORACLE) revert BadCloseMode(p.mode);
        uint256 lastSeen = updatedAt > lastFreshPrice[p.market] ? updatedAt : lastFreshPrice[p.market];
        if (fresh || block.timestamp - lastSeen < ORACLE_DEAD_AFTER) revert OracleNotDead(p.market);
        return 0;
    }

    function _flattenPair(bytes32[PAIR_CT_LEN][PAIR_RECIPIENTS] calldata ct) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](PAIR_RECIPIENTS * PAIR_CT_LEN);
        for (uint256 i; i < PAIR_RECIPIENTS; i++) {
            for (uint256 j; j < PAIR_CT_LEN; j++) out[i * PAIR_CT_LEN + j] = ct[i][j];
        }
    }




    function _verifyEpoch(bytes calldata proof, FundingPublic calldata p, Market memory m, bytes32[] memory deltas, uint256 dt, uint256 mark) internal view {
        bytes32[] memory inputs = PairInputs.funding(p, m, _keys(), deltas, EpochContext(_funding[p.market].head, dt, mark, marketBond[p.market]));
        if (!fundingEpochVerifier.verify(proof, inputs)) revert InvalidProof();
    }

    function _verifyUpdate(bytes calldata proof, UpdatePublic calldata p, Market memory m, uint256 mark) internal view {
        bytes32[] memory inputs = PairInputs.update(p, m, _keys(), mark, _funding[p.market].index);
        if (!updateVerifier.verify(proof, inputs)) revert InvalidProof();
    }

    function _keys() internal view returns (Keys memory) {
        return Keys(deploymentId, coordinatorX, coordinatorY, riskAX, riskAY, riskBX, riskBY, feeAuth, feeX, feeY);
    }

    function _market(uint256 id) internal view returns (Market memory m) {
        m = _markets[id];
        if (m.asset == address(0)) revert UnknownMarket(id);
    }

    function _requireRoot(bytes32 r) internal view {
        if (!isKnownRoot(r)) revert UnknownRoot(r);
    }

    function _consume(bytes32 nf) internal {
        if (nullifierSpent[nf]) revert NullifierSpent(nf);
        nullifierSpent[nf] = true;
    }

    function _emitConsumed(bytes32 nf) internal {
        bytes32[] memory nfs = new bytes32[](1);
        nfs[0] = nf;
        emit RecordsConsumed(nfs);
    }

    function _create(uint8 kind, bytes32 commitment, bytes32[] memory ciphertext) internal {
        uint256 index = _push(Entry(KIND_LEAF, commitment, 0, 0));
        emit RecordCreated(index, kind, commitment, ciphertext);
    }

    function _copy(bytes32[NOTE_CT_LEN] calldata ct) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](NOTE_CT_LEN);
        for (uint256 i; i < NOTE_CT_LEN; i++) out[i] = ct[i];
    }
}
