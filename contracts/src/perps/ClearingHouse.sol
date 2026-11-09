// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {QuoteVerifier} from "./QuoteVerifier.sol";
import {RiskMath} from "../lib/RiskMath.sol";
import {Types} from "../lib/Types.sol";

interface IMarginVault {
    function scale() external view returns (uint256);
    function balanceOf(bytes32 domain, address account) external view returns (uint256);
    function move(bytes32 fromDomain, address from, bytes32 toDomain, address to, uint256 amount) external;
}

interface IMarketRegistry {
    function getMarket(bytes32 marketId) external view returns (Types.Market memory);
    function reportCloseOnly(bytes32 marketId) external;
}

interface IOracleAdapter {
    function getFreshPrice(bytes32 feedId) external view returns (uint256);
    function getPrice(bytes32 feedId) external view returns (uint256 priceWad, uint256 updatedAt, bool fresh);
    function isFresh(bytes32 feedId) external view returns (bool);
}

interface IMarketBackstop {
    function coverShortfall(bytes32 marketId, bytes32 toDomain, address to, uint256 amount) external returns (uint256);
    function creditInsurance(bytes32 marketId, bytes32 fromDomain, address from, uint256 amount) external;
}

/// @title ClearingHouse
/// @notice Settles collateral-backed perpetual positions between a taker and the maker who signed the
///         quote. Every position is a matched pair: the maker holds exactly the opposite size, both sides
///         post isolated margin inside the pair's own vault domain, and every PnL or funding settlement is
///         one integer moved from one side's margin to the other's. Value is never created.
/// @dev Units: see Types. Sign convention: `size` is the taker's, positive = long; the maker is -size.
///      Stale price: opening, increasing, liquidating and removing margin require a fresh oracle price.
///      Reducing and closing remain available with a stale price because they settle bilaterally at the
///      maker-signed price, and only if the losing side's margin fully covers the transfer (no backstop).
///      Privileged actions: none. Fee claims go only to the immutable `feeRecipient`.
///      V1 limits (documented, intentional): one maker per taker position per market; no flips in one
///      trade; full (not partial) liquidation; no auto-deleveraging.
contract ClearingHouse is QuoteVerifier, ReentrancyGuard {
    using SafeCast for uint256;
    using SafeCast for int256;
    bytes32 public constant FEES_DOMAIN = keccak256("ROOQ_FEES");
    bytes32 private constant FREE = bytes32(0);
    /// @notice Funding accrues for at most this long per touch, so an untouched or unpriced gap is never
    ///         billed in one step. Keepers touch markets far more often than this.
    uint64 public constant MAX_FUNDING_WINDOW = 1 hours;

    IMarginVault public immutable vault;
    IMarketRegistry public immutable registry;
    IOracleAdapter public immutable oracle;
    IMarketBackstop public immutable backstop;
    address public immutable feeRecipient;
    uint256 public immutable scale;

    struct Pair {
        address maker;
        int256 size;
        uint256 entryPrice;
        int256 fundingSnapshot;
        int256 realizedPnl;
    }

    struct MarketState {
        int256 fundingIndex;
        uint64 lastFundingTime;
        uint256 longOi;
        uint256 shortOi;
        uint256 badDebt;
        uint256 commitTotal;
        uint256 unpaidFunding;
    }

    struct Ctx {
        bytes32 marketId;
        bytes32 dom;
        address taker;
        address maker;
        int256 fill;
        uint256 price;
        uint256 mark;
        bool fresh;
        Types.RiskParams risk;
    }

    mapping(bytes32 marketId => mapping(address taker => Pair)) private _pairs;
    mapping(bytes32 marketId => MarketState) private _state;

    error TradeExpired();
    error SelfTrade();
    error FlipNotAllowed();
    error MakerMismatch(address existing, address quoted);
    error MarketNotOpen(Types.PerpStatus status);
    error LimitPriceExceeded();
    error FeeAboveMax(uint16 feeBps, uint16 maxFeeBps);
    error PriceDeviation(uint256 quotePrice, uint256 markPrice);
    error MaxOpenInterest(uint256 oiUsdWad, uint256 capUsdWad);
    error MarginTooLow(int256 equity, uint256 required);
    error MakerCapacityExhausted();
    error InsufficientMarginForSettlement(uint256 owed, uint256 available);
    error StaleReduceMustClose();
    error NotLiquidatable();
    error NoPosition();
    error NotMaker();
    error MarketHealthy();
    error BackingNotAccepted(Types.PerpStatus status);
    error BackingBelowMinimum(uint256 remaining, uint256 minimum);
    error NotFeeRecipient();
    error NothingToClaim();

    event TradeExecuted(
        bytes32 indexed marketId,
        address indexed taker,
        address indexed maker,
        int256 sizeDelta,
        uint256 price,
        uint256 markPrice,
        uint256 fee,
        int256 realizedPnl,
        bytes32 quoteHash
    );
    event PositionChanged(
        bytes32 indexed marketId,
        address indexed taker,
        address indexed maker,
        int256 size,
        uint256 entryPrice,
        uint256 takerMargin,
        uint256 makerMargin
    );
    event FundingAccrued(bytes32 indexed marketId, int256 index, int256 ratePerSecond, uint256 price, uint64 timestamp);
    /// @dev `takerOwed` is what the funding index charged; `takerPaid` is what moved (same sign, never larger).
    event FundingSettled(
        bytes32 indexed marketId, address indexed taker, address indexed maker, int256 takerOwed, int256 takerPaid
    );
    event Liquidated(
        bytes32 indexed marketId,
        address indexed taker,
        address indexed liquidator,
        bool makerSide,
        uint256 markPrice,
        int256 takerPnl,
        uint256 penalty,
        uint256 shortfallCovered,
        uint256 badDebt
    );
    event SettledAtMark(bytes32 indexed marketId, address indexed taker, uint256 markPrice, int256 takerPnl);
    event MarginChanged(bytes32 indexed marketId, address indexed account, int256 delta);
    event BackingChanged(bytes32 indexed marketId, address indexed maker, int256 delta, uint256 commitTotal);
    event BadDebtRecorded(bytes32 indexed marketId, uint256 amount, uint256 total);
    event FundingShortfall(bytes32 indexed marketId, address indexed payer, uint256 amount, uint256 total);
    event ProtocolFeesClaimed(address indexed to, uint256 amount);

    constructor(address vault_, address registry_, address oracle_, address backstop_, address feeRecipient_) {
        vault = IMarginVault(vault_);
        registry = IMarketRegistry(registry_);
        oracle = IOracleAdapter(oracle_);
        backstop = IMarketBackstop(backstop_);
        feeRecipient = feeRecipient_;
        scale = IMarginVault(vault_).scale();
    }

    // ================================================================== trading

    /// @notice Fill a maker quote. Opens, increases or reduces the caller's position against that maker.
    function trade(Types.Quote calldata q, bytes calldata sig, Types.TradeParams calldata p)
        external
        nonReentrant
        returns (bytes32 quoteHash)
    {
        if (block.timestamp > p.deadline) revert TradeExpired();
        if (msg.sender == q.maker) revert SelfTrade();
        Types.Market memory m = registry.getMarket(q.marketId);
        Pair storage pr = _pairs[q.marketId][msg.sender];
        int256 s = pr.size;
        bool increase = s == 0 || (s > 0) == (p.fillSize > 0);
        if (!increase && RiskMath.abs(p.fillSize) > RiskMath.abs(s)) revert FlipNotAllowed();
        if (s != 0 && pr.maker != q.maker) revert MakerMismatch(pr.maker, q.maker);
        if (
            increase
                ? m.perpStatus != Types.PerpStatus.ACTIVE
                : (m.perpStatus != Types.PerpStatus.ACTIVE && m.perpStatus != Types.PerpStatus.CLOSE_ONLY)
        ) revert MarketNotOpen(m.perpStatus);

        quoteHash = _consumeQuote(q, sig, p.fillSize, m.risk.version, msg.sender);
        if (p.fillSize > 0 ? q.price > p.limitPrice : q.price < p.limitPrice) revert LimitPriceExceeded();
        if (m.risk.takerFeeBps > p.maxFeeBps) revert FeeAboveMax(m.risk.takerFeeBps, p.maxFeeBps);

        Ctx memory c;
        c.marketId = q.marketId;
        c.dom = pairDomain(q.marketId, msg.sender);
        c.taker = msg.sender;
        c.maker = q.maker;
        c.fill = p.fillSize;
        c.price = q.price;
        c.risk = m.risk;
        _execute(c, pr, m.feedId, increase, p.marginDeposit, quoteHash);
    }

    function _execute(
        Ctx memory c,
        Pair storage pr,
        bytes32 feedId,
        bool increase,
        uint256 marginDeposit,
        bytes32 quoteHash
    ) internal {
        if (increase) {
            c.mark = oracle.getFreshPrice(feedId);
            c.fresh = true;
        } else {
            (c.mark,, c.fresh) = oracle.getPrice(feedId);
        }
        if (c.fresh) _checkDeviation(c.price, c.mark, c.risk.maxDeviationBps);

        _accrue(c.marketId, c.risk, c.mark, c.fresh);
        if (pr.size != 0) _settleFunding(c.marketId, c.taker, pr, c.dom);

        int256 realized;
        if (increase) _increase(c, pr, marginDeposit);
        else realized = _reduce(c, pr);

        uint256 feeAmt = RiskMath.fee(RiskMath.abs(c.fill), c.price, c.risk.takerFeeBps, scale);
        _chargeFee(c, feeAmt, increase);

        emit TradeExecuted(c.marketId, c.taker, c.maker, c.fill, c.price, c.mark, feeAmt, realized, quoteHash);
        _emitPosition(c.marketId, c.taker, c.maker, c.dom);
    }

    function _increase(Ctx memory c, Pair storage pr, uint256 marginDeposit) internal {
        uint256 absD = RiskMath.abs(c.fill);
        if (pr.size == 0) {
            pr.maker = c.maker;
            pr.entryPrice = c.price;
            pr.fundingSnapshot = _state[c.marketId].fundingIndex;
        } else {
            pr.entryPrice = RiskMath.weightedEntry(RiskMath.abs(pr.size), pr.entryPrice, absD, c.price);
        }
        pr.size += c.fill;
        if (marginDeposit != 0) {
            vault.move(FREE, c.taker, c.dom, c.taker, marginDeposit);
            emit MarginChanged(c.marketId, c.taker, marginDeposit.toInt256());
        }

        MarketState storage st = _state[c.marketId];
        if (c.fill > 0) st.longOi += absD;
        else st.shortOi += absD;
        uint256 oiUsd = RiskMath.notionalUp(st.longOi + st.shortOi, c.mark);
        if (oiUsd > c.risk.maxOiUsdWad) revert MaxOpenInterest(oiUsd, c.risk.maxOiUsdWad);

        uint256 im = RiskMath.marginRequirement(RiskMath.abs(pr.size), c.mark, c.risk.imrWad, scale);
        uint256 takerMargin = vault.balanceOf(c.dom, c.taker);
        uint256 makerMargin = _fundMakerToInitial(c, pr, im, takerMargin);
        int256 eT = _certified(takerMargin, RiskMath.pnlFloor(pr.size, pr.entryPrice, c.mark, scale), makerMargin);
        if (eT < im.toInt256()) revert MarginTooLow(eT, im);
    }

    /// @dev Tops the maker's side of the pair up to initial margin from its market commitment.
    function _fundMakerToInitial(Ctx memory c, Pair storage pr, uint256 im, uint256 takerMargin)
        internal
        returns (uint256 makerMargin)
    {
        makerMargin = vault.balanceOf(c.dom, c.maker);
        int256 eM = _certified(makerMargin, RiskMath.pnlFloor(-pr.size, pr.entryPrice, c.mark, scale), takerMargin);
        if (eM >= im.toInt256()) return makerMargin;
        uint256 need = (im.toInt256() - eM).toUint256();
        bytes32 cd = commitDomain(c.marketId);
        if (vault.balanceOf(cd, c.maker) < need) revert MakerCapacityExhausted();
        vault.move(cd, c.maker, c.dom, c.maker, need);
        _state[c.marketId].commitTotal -= need;
        makerMargin += need;
    }

    function _reduce(Ctx memory c, Pair storage pr) internal returns (int256 realized) {
        int256 s = pr.size;
        // Without a fresh price nothing bounds the maker-signed price, so only a full close is allowed:
        // a partial reduce could move one side's margin away and leave an undercollateralised pair open.
        if (!c.fresh && s + c.fill != 0) revert StaleReduceMustClose();
        // The closed portion, from the taker's side, is -fill.
        realized = RiskMath.pnlTrunc(-c.fill, pr.entryPrice, c.price, scale);
        if (realized != 0) {
            (address payer, address receiver) = realized > 0 ? (c.maker, c.taker) : (c.taker, c.maker);
            uint256 owed = RiskMath.abs(realized);
            uint256 available = vault.balanceOf(c.dom, payer);
            if (owed > available) revert InsufficientMarginForSettlement(owed, available);
            vault.move(c.dom, payer, c.dom, receiver, owed);
        }
        pr.realizedPnl += realized;
        pr.size = s + c.fill;

        MarketState storage st = _state[c.marketId];
        if (s > 0) st.longOi -= RiskMath.abs(c.fill);
        else st.shortOi -= RiskMath.abs(c.fill);

        if (pr.size == 0) {
            _releaseAll(c.marketId, c.dom, c.taker, c.maker);
            delete _pairs[c.marketId][c.taker];
        } else if (c.fresh) {
            // Return maker margin above initial margin to its market commitment.
            uint256 im = RiskMath.marginRequirement(RiskMath.abs(pr.size), c.mark, c.risk.imrWad, scale);
            uint256 makerMargin = vault.balanceOf(c.dom, c.maker);
            int256 eM = makerMargin.toInt256() + RiskMath.pnlFloor(-pr.size, pr.entryPrice, c.mark, scale);
            if (eM > im.toInt256()) {
                uint256 excess = (eM - im.toInt256()).toUint256();
                if (excess > makerMargin) excess = makerMargin;
                _toCommit(c.marketId, c.dom, c.maker, excess);
            }
        }
    }

    // ================================================================== margin and backing

    function addMargin(bytes32 marketId, uint256 amount) external nonReentrant {
        if (_pairs[marketId][msg.sender].size == 0) revert NoPosition();
        bytes32 dom = pairDomain(marketId, msg.sender);
        vault.move(FREE, msg.sender, dom, msg.sender, amount);
        emit MarginChanged(marketId, msg.sender, amount.toInt256());
        _emitPosition(marketId, msg.sender, _pairs[marketId][msg.sender].maker, dom);
    }

    /// @notice Withdraw taker margin down to the initial-margin requirement at a fresh price.
    function removeMargin(bytes32 marketId, uint256 amount) external nonReentrant {
        Types.Market memory m = registry.getMarket(marketId);
        if (m.perpStatus != Types.PerpStatus.ACTIVE && m.perpStatus != Types.PerpStatus.CLOSE_ONLY) {
            revert MarketNotOpen(m.perpStatus);
        }
        Pair storage pr = _pairs[marketId][msg.sender];
        if (pr.size == 0) revert NoPosition();
        uint256 mark = oracle.getFreshPrice(m.feedId);
        bytes32 dom = pairDomain(marketId, msg.sender);
        _accrue(marketId, m.risk, mark, true);
        _settleFunding(marketId, msg.sender, pr, dom);

        vault.move(dom, msg.sender, FREE, msg.sender, amount);
        uint256 im = RiskMath.marginRequirement(RiskMath.abs(pr.size), mark, m.risk.imrWad, scale);
        int256 eT = _certified(
            vault.balanceOf(dom, msg.sender),
            RiskMath.pnlFloor(pr.size, pr.entryPrice, mark, scale),
            vault.balanceOf(dom, pr.maker)
        );
        if (eT < im.toInt256()) revert MarginTooLow(eT, im);
        emit MarginChanged(marketId, msg.sender, -amount.toInt256());
        _emitPosition(marketId, msg.sender, pr.maker, dom);
    }

    /// @notice Maker moves committed backing into one of its pairs to stay above maintenance.
    function makerTopUp(bytes32 marketId, address taker, uint256 amount) external nonReentrant {
        Pair storage pr = _pairs[marketId][taker];
        if (pr.size == 0) revert NoPosition();
        if (pr.maker != msg.sender) revert NotMaker();
        bytes32 dom = pairDomain(marketId, taker);
        vault.move(commitDomain(marketId), msg.sender, dom, msg.sender, amount);
        _state[marketId].commitTotal -= amount;
        emit BackingChanged(marketId, msg.sender, -amount.toInt256(), _state[marketId].commitTotal);
        _emitPosition(marketId, taker, msg.sender, dom);
    }

    /// @notice Pledge collateral to back quotes in one market. Fills draw maker margin from here.
    function commitBacking(bytes32 marketId, uint256 amount) external nonReentrant {
        Types.PerpStatus status = registry.getMarket(marketId).perpStatus;
        if (
            status != Types.PerpStatus.REGISTERED && status != Types.PerpStatus.ACTIVE
                && status != Types.PerpStatus.CLOSE_ONLY
        ) revert BackingNotAccepted(status);
        vault.move(FREE, msg.sender, commitDomain(marketId), msg.sender, amount);
        uint256 total = _state[marketId].commitTotal + amount;
        _state[marketId].commitTotal = total;
        emit BackingChanged(marketId, msg.sender, amount.toInt256(), total);
    }

    /// @notice Withdraw unreserved backing. While perps are ACTIVE the market's total uncommitted
    ///         backing may not drop below the activation minimum.
    function withdrawBacking(bytes32 marketId, uint256 amount) external nonReentrant {
        Types.Market memory m = registry.getMarket(marketId);
        uint256 remaining = _state[marketId].commitTotal - amount;
        if (m.perpStatus == Types.PerpStatus.ACTIVE && remaining < m.risk.minMakerBacking) {
            revert BackingBelowMinimum(remaining, m.risk.minMakerBacking);
        }
        vault.move(commitDomain(marketId), msg.sender, FREE, msg.sender, amount);
        _state[marketId].commitTotal = remaining;
        emit BackingChanged(marketId, msg.sender, -amount.toInt256(), remaining);
    }

    // ================================================================== funding

    function accrueFunding(bytes32 marketId) external {
        Types.Market memory m = registry.getMarket(marketId);
        (uint256 mark,, bool fresh) = oracle.getPrice(m.feedId);
        _accrue(marketId, m.risk, mark, fresh);
    }

    function settleFunding(bytes32 marketId, address taker) external nonReentrant {
        Types.Market memory m = registry.getMarket(marketId);
        (uint256 mark,, bool fresh) = oracle.getPrice(m.feedId);
        _accrue(marketId, m.risk, mark, fresh);
        Pair storage pr = _pairs[marketId][taker];
        if (pr.size == 0) revert NoPosition();
        bytes32 dom = pairDomain(marketId, taker);
        _settleFunding(marketId, taker, pr, dom);
        _emitPosition(marketId, taker, pr.maker, dom);
    }

    function _accrue(bytes32 marketId, Types.RiskParams memory risk, uint256 mark, bool fresh) internal {
        MarketState storage st = _state[marketId];
        uint64 nowTs = uint64(block.timestamp);
        uint64 last = st.lastFundingTime;
        if (last == nowTs) return;
        st.lastFundingTime = nowTs;
        if (last == 0 || !fresh) return; // first touch, or stale price: freeze, never fabricate movement
        int256 rate = RiskMath.fundingRatePerSecond(st.longOi, st.shortOi, risk.maxFundingRatePerHourWad);
        if (rate == 0) return;
        uint64 dt = nowTs - last;
        if (dt > MAX_FUNDING_WINDOW) dt = MAX_FUNDING_WINDOW;
        st.fundingIndex += RiskMath.fundingIndexDelta(rate, dt, mark);
        emit FundingAccrued(marketId, st.fundingIndex, rate, mark, nowTs);
    }

    function _settleFunding(bytes32 marketId, address taker, Pair storage pr, bytes32 dom) internal {
        int256 idx = _state[marketId].fundingIndex;
        int256 delta = idx - pr.fundingSnapshot;
        pr.fundingSnapshot = idx;
        if (delta == 0 || pr.size == 0) return;
        int256 owed = RiskMath.fundingOwed(pr.size, delta, scale);
        if (owed == 0) return;
        (address payer, address receiver) = owed > 0 ? (taker, pr.maker) : (pr.maker, taker);
        uint256 amount = RiskMath.abs(owed);
        uint256 available = vault.balanceOf(dom, payer);
        uint256 paid = amount < available ? amount : available;
        vault.move(dom, payer, dom, receiver, paid);
        if (amount > paid) {
            // Funding never draws the backstop. A payer with no margin left does not pay the rest: the gap
            // is written off (ADR-P09), the receiver is short-paid, and only the market total is recorded.
            uint256 total = _state[marketId].unpaidFunding + (amount - paid);
            _state[marketId].unpaidFunding = total;
            emit FundingShortfall(marketId, payer, amount - paid, total);
        }
        emit FundingSettled(marketId, taker, pr.maker, owed, owed > 0 ? int256(paid) : -int256(paid));
    }

    /// @dev Opening fees come from free collateral. Reduce and close fees take free collateral first and
    ///      then the position's own margin, so an exit never fails for lack of a free balance.
    function _chargeFee(Ctx memory c, uint256 feeAmt, bool increase) internal {
        if (feeAmt == 0) return;
        uint256 free = vault.balanceOf(FREE, c.taker);
        if (increase || free >= feeAmt) {
            vault.move(FREE, c.taker, FEES_DOMAIN, address(0), feeAmt);
            return;
        }
        if (free != 0) vault.move(FREE, c.taker, FEES_DOMAIN, address(0), free);
        vault.move(c.dom, c.taker, FEES_DOMAIN, address(0), feeAmt - free);
    }

    // ================================================================== liquidation and settlement

    /// @notice Permissionless. Closes the whole pair at the fresh mark if either side is below maintenance.
    ///         The unhealthy side pays a capped penalty: half to the caller, half to this market's insurance.
    function liquidate(bytes32 marketId, address taker) external nonReentrant {
        Types.Market memory m = registry.getMarket(marketId);
        if (
            m.perpStatus != Types.PerpStatus.ACTIVE && m.perpStatus != Types.PerpStatus.CLOSE_ONLY
                && m.perpStatus != Types.PerpStatus.SETTLEMENT_PENDING
        ) revert MarketNotOpen(m.perpStatus);
        Pair storage pr = _pairs[marketId][taker];
        if (pr.size == 0) revert NoPosition();
        uint256 mark = oracle.getFreshPrice(m.feedId);
        bytes32 dom = pairDomain(marketId, taker);
        _accrue(marketId, m.risk, mark, true);
        _settleFunding(marketId, taker, pr, dom);

        uint256 mm = RiskMath.marginRequirement(RiskMath.abs(pr.size), mark, m.risk.mmrWad, scale);
        int256 eT = (vault.balanceOf(dom, taker)).toInt256() + RiskMath.pnlFloor(pr.size, pr.entryPrice, mark, scale);
        int256 eM = (vault.balanceOf(dom, pr.maker)).toInt256() + RiskMath.pnlFloor(-pr.size, pr.entryPrice, mark, scale);
        bool makerSide;
        if (eT < mm.toInt256()) makerSide = false;
        else if (eM < mm.toInt256()) makerSide = true;
        else revert NotLiquidatable();
        _closeAtMark(marketId, m.risk, pr, dom, taker, mark, true, makerSide);
    }

    /// @notice Emergency exit once the guardian has moved a market to SETTLEMENT_PENDING (for example the
    ///         maker disappeared). Anyone may close any pair at the fresh mark, without penalty.
    function settleAtMark(bytes32 marketId, address taker) external nonReentrant {
        Types.Market memory m = registry.getMarket(marketId);
        if (m.perpStatus != Types.PerpStatus.SETTLEMENT_PENDING) revert MarketNotOpen(m.perpStatus);
        Pair storage pr = _pairs[marketId][taker];
        if (pr.size == 0) revert NoPosition();
        uint256 mark = oracle.getFreshPrice(m.feedId);
        bytes32 dom = pairDomain(marketId, taker);
        _accrue(marketId, m.risk, mark, true);
        _settleFunding(marketId, taker, pr, dom);
        _closeAtMark(marketId, m.risk, pr, dom, taker, mark, false, false);
    }

    function _closeAtMark(
        bytes32 marketId,
        Types.RiskParams memory risk,
        Pair storage pr,
        bytes32 dom,
        address taker,
        uint256 mark,
        bool penalize,
        bool makerSide
    ) internal {
        address maker = pr.maker;
        int256 pnl = RiskMath.pnlTrunc(pr.size, pr.entryPrice, mark, scale);
        (uint256 covered, uint256 bad) = pnl > 0
            ? _payWithBackstop(marketId, dom, maker, taker, pnl.toUint256())
            : _payWithBackstop(marketId, dom, taker, maker, (-pnl).toUint256());

        uint256 penalty;
        if (penalize) {
            uint256 base = RiskMath.liquidationPenalty(RiskMath.abs(pr.size), mark, risk.liqPenaltyBps, scale);
            penalty = _chargePenalty(marketId, dom, makerSide ? maker : taker, base);
        }

        MarketState storage st = _state[marketId];
        if (pr.size > 0) st.longOi -= RiskMath.abs(pr.size);
        else st.shortOi -= RiskMath.abs(pr.size);
        _releaseAll(marketId, dom, taker, maker);
        delete _pairs[marketId][taker];

        if (penalize) emit Liquidated(marketId, taker, msg.sender, makerSide, mark, pnl, penalty, covered, bad);
        else emit SettledAtMark(marketId, taker, mark, pnl);
        emit PositionChanged(marketId, taker, maker, 0, 0, 0, 0);
    }

    /// @dev Moves `owed` from payer to receiver inside the pair; any gap is drawn from this market's
    ///      backstop, and whatever the backstop cannot cover is recorded as bad debt.
    function _payWithBackstop(bytes32 marketId, bytes32 dom, address payer, address receiver, uint256 owed)
        internal
        returns (uint256 covered, uint256 bad)
    {
        if (owed == 0) return (0, 0);
        uint256 available = vault.balanceOf(dom, payer);
        uint256 paid = owed < available ? owed : available;
        vault.move(dom, payer, dom, receiver, paid);
        if (owed > paid) {
            uint256 shortfall = owed - paid;
            covered = backstop.coverShortfall(marketId, dom, receiver, shortfall);
            bad = shortfall - covered;
            if (bad != 0) _recordBadDebt(marketId, bad);
        }
    }

    function _chargePenalty(bytes32 marketId, bytes32 dom, address liquidated, uint256 penalty)
        internal
        returns (uint256)
    {
        uint256 remaining = vault.balanceOf(dom, liquidated);
        if (penalty > remaining) penalty = remaining;
        uint256 toCaller = penalty / 2;
        if (toCaller != 0) vault.move(dom, liquidated, FREE, msg.sender, toCaller);
        backstop.creditInsurance(marketId, dom, liquidated, penalty - toCaller);
        return penalty;
    }

    /// @notice Permissionless: moves an ACTIVE market to CLOSE_ONLY while its price feed is not fresh.
    function triggerCloseOnly(bytes32 marketId) external {
        Types.Market memory m = registry.getMarket(marketId);
        if (m.perpStatus != Types.PerpStatus.ACTIVE || oracle.isFresh(m.feedId)) revert MarketHealthy();
        registry.reportCloseOnly(marketId);
    }

    // ================================================================== fees

    function claimProtocolFees(address to) external nonReentrant {
        if (msg.sender != feeRecipient) revert NotFeeRecipient();
        uint256 amount = vault.balanceOf(FEES_DOMAIN, address(0));
        if (amount == 0) revert NothingToClaim();
        vault.move(FEES_DOMAIN, address(0), FREE, to, amount);
        emit ProtocolFeesClaimed(to, amount);
    }

    // ================================================================== views

    function pairDomain(bytes32 marketId, address taker) public pure returns (bytes32) {
        return keccak256(abi.encode("ROOQ_PAIR", marketId, taker));
    }

    function commitDomain(bytes32 marketId) public pure returns (bytes32) {
        return keccak256(abi.encode("ROOQ_COMMIT", marketId));
    }

    function getPair(bytes32 marketId, address taker) external view returns (Types.PairView memory v) {
        Pair storage pr = _pairs[marketId][taker];
        bytes32 dom = pairDomain(marketId, taker);
        v.taker = taker;
        v.maker = pr.maker;
        v.size = pr.size;
        v.entryPrice = pr.entryPrice;
        v.takerMargin = vault.balanceOf(dom, taker);
        v.makerMargin = pr.maker == address(0) ? 0 : vault.balanceOf(dom, pr.maker);
        v.realizedPnl = pr.realizedPnl;
        v.fundingSnapshot = pr.fundingSnapshot;
    }

    function openInterest(bytes32 marketId) external view returns (uint256 longOi, uint256 shortOi) {
        return (_state[marketId].longOi, _state[marketId].shortOi);
    }

    function totalOpenInterest(bytes32 marketId) external view returns (uint256) {
        return _state[marketId].longOi + _state[marketId].shortOi;
    }

    function fundingIndex(bytes32 marketId) external view returns (int256) {
        return _state[marketId].fundingIndex;
    }

    function lastFundingTime(bytes32 marketId) external view returns (uint64) {
        return _state[marketId].lastFundingTime;
    }

    function badDebt(bytes32 marketId) external view returns (uint256) {
        return _state[marketId].badDebt;
    }

    function unpaidFunding(bytes32 marketId) external view returns (uint256) {
        return _state[marketId].unpaidFunding;
    }

    function commitTotal(bytes32 marketId) external view returns (uint256) {
        return _state[marketId].commitTotal;
    }

    // ================================================================== internal

    function _certified(uint256 margin, int256 pnl, uint256 counterpartyMargin) internal pure returns (int256) {
        // Positive unrealised PnL counts only up to what the counterparty has actually posted.
        if (pnl > 0 && pnl.toUint256() > counterpartyMargin) pnl = counterpartyMargin.toInt256();
        return margin.toInt256() + pnl;
    }

    function _checkDeviation(uint256 price, uint256 mark, uint16 maxBps) internal pure {
        uint256 diff = price > mark ? price - mark : mark - price;
        if (diff * 10_000 > mark * maxBps) revert PriceDeviation(price, mark);
    }

    function _toCommit(bytes32 marketId, bytes32 fromDomain, address maker, uint256 amount) internal {
        if (amount == 0) return;
        vault.move(fromDomain, maker, commitDomain(marketId), maker, amount);
        uint256 total = _state[marketId].commitTotal + amount;
        _state[marketId].commitTotal = total;
        emit BackingChanged(marketId, maker, amount.toInt256(), total);
    }

    function _releaseAll(bytes32 marketId, bytes32 dom, address taker, address maker) internal {
        uint256 tm = vault.balanceOf(dom, taker);
        if (tm != 0) {
            vault.move(dom, taker, FREE, taker, tm);
            emit MarginChanged(marketId, taker, -tm.toInt256());
        }
        _toCommit(marketId, dom, maker, vault.balanceOf(dom, maker));
    }

    function _recordBadDebt(bytes32 marketId, uint256 amount) internal {
        uint256 total = _state[marketId].badDebt + amount;
        _state[marketId].badDebt = total;
        emit BadDebtRecorded(marketId, amount, total);
        registry.reportCloseOnly(marketId);
    }

    function _emitPosition(bytes32 marketId, address taker, address maker, bytes32 dom) internal {
        Pair storage pr = _pairs[marketId][taker];
        emit PositionChanged(
            marketId,
            taker,
            maker,
            pr.size,
            pr.entryPrice,
            vault.balanceOf(dom, taker),
            maker == address(0) ? 0 : vault.balanceOf(dom, maker)
        );
    }
}
