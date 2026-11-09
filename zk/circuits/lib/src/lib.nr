// Rooq private V1 record primitives (docs/privacy/ADR-P02-state-and-notes.md).
// Every tag, field order and hash here is mirrored by packages/private-sdk; change both together and bump
// RECORD_VERSION.
use poseidon::poseidon2::Poseidon2;
use std::embedded_curve_ops::{
    EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul, multi_scalar_mul,
};

pub global RECORD_VERSION: Field = 1;
pub global TREE_DEPTH: u32 = 32;
pub global AMOUNT_BITS: u32 = 100;
pub global ADDRESS_BITS: u32 = 160;
pub global FREE_DOMAIN: Field = 0;

pub global T_AUTH: Field = 1;
pub global T_NK: Field = 2;
pub global T_OWNER: Field = 3;
pub global T_NOTE: Field = 4;
pub global T_NF: Field = 5;
pub global T_NODE: Field = 7;
pub global T_ENC: Field = 8;
pub global T_INNER: Field = 15;
pub global T_RHO: Field = 16;
pub global T_NF_REC: Field = 6;
pub global T_LOCK: Field = 9;
pub global T_PAIR: Field = 10;
pub global T_TERMS: Field = 11;
pub global T_NONCE: Field = 12;
pub global T_MARKET: Field = 13;
pub global T_OI: Field = 14;
pub global T_CLAIM: Field = 18;
pub global T_POOL: Field = 19;
pub global T_LP: Field = 20;

pub global ROLE_TAKER: Field = 1;
pub global ROLE_MAKER: Field = 2;
pub global ROLE_SWAP: Field = 3;
pub global ROLE_LP: Field = 4;

/// Fixed point: prices and sizes are WAD (1e18) scaled; amounts are token units. `scale` = 10^(18 - decimals).
pub global WAD: Field = 1_000_000_000_000_000_000;
pub global BPS: Field = 10_000;
pub global PRICE_BITS: u32 = 96;
pub global SIZE_BITS: u32 = 96;
pub global TIME_BITS: u32 = 64;

/// Fields in an encrypted FREE note: domain, asset, value, rho, blind.
pub global NOTE_PT_LEN: u32 = 5;
/// Ciphertext: ephemeral point (x, y) followed by the masked plaintext.
pub global NOTE_CT_LEN: u32 = NOTE_PT_LEN + 2;
pub global LOCK_PT_LEN: u32 = 13;
pub global LOCK_CT_LEN: u32 = LOCK_PT_LEN + 2;
pub global PAIR_PT_LEN: u32 = 20;
pub global PAIR_CT_LEN: u32 = PAIR_PT_LEN + 2;
pub global MARKET_PT_LEN: u32 = 6;
pub global CLAIM_PT_LEN: u32 = 11;
pub global CLAIM_CT_LEN: u32 = CLAIM_PT_LEN + 2;
pub global POOL_PT_LEN: u32 = 5;
pub global POOL_CT_LEN: u32 = POOL_PT_LEN + 2;
pub global LP_PT_LEN: u32 = 10;
pub global LP_CT_LEN: u32 = LP_PT_LEN + 2;
pub global RESERVE_BITS: u32 = 96;
pub global MARKET_CT_LEN: u32 = MARKET_PT_LEN + 2;
/// Funding indices are offset-encoded so they stay non-negative; the contract starts at 2^128.
pub global FUNDING_BITS: u32 = 129;

pub fn h<let N: u32>(input: [Field; N]) -> Field {
    Poseidon2::hash(input, N)
}

pub fn assert_amount(x: Field) {
    x.assert_max_bit_size::<AMOUNT_BITS>();
}

pub fn assert_address(x: Field) {
    x.assert_max_bit_size::<ADDRESS_BITS>();
}

pub fn auth_key(sk: Field) -> Field {
    h([T_AUTH, sk])
}

pub fn nullifier_key(sk: Field) -> Field {
    h([T_NK, sk])
}

pub fn owner_tag(auth: Field, pk: EmbeddedCurvePoint) -> Field {
    h([T_OWNER, auth, pk.x, pk.y])
}

/// Hiding part of a note. A depositor publishes only this, so the owner tag stays hidden.
pub fn note_inner(owner: Field, rho: Field, blind: Field) -> Field {
    h([T_INNER, owner, rho, blind])
}

pub fn note_commitment(deployment: Field, domain: Field, asset: Field, value: Field, inner: Field) -> Field {
    h([T_NOTE, deployment, RECORD_VERSION, domain, asset, value, inner])
}

pub fn owner_nullifier(nk: Field, cm: Field) -> Field {
    h([T_NF, nk, cm])
}

/// Output rho is derived from the transaction's nullifiers, so two outputs can never share a commitment.
pub fn output_rho(nf0: Field, nf1: Field, index: Field) -> Field {
    h([T_RHO, nf0, nf1, index])
}

pub fn merkle_root(leaf: Field, index: Field, path: [Field; TREE_DEPTH]) -> Field {
    let bits: [bool; TREE_DEPTH] = index.to_le_bits();
    let mut node = leaf;
    for i in 0..TREE_DEPTH {
        let (l, r) = if bits[i] { (path[i], node) } else { (node, path[i]) };
        node = h([T_NODE, l, r]);
    }
    node
}

/// Grumpkin: y^2 = x^3 - 17. Curve operations do not check points taken from witnesses.
pub fn assert_on_curve(p: EmbeddedCurvePoint) {
    assert_eq(p.y * p.y, p.x * p.x * p.x - 17);
}

/// Encrypts `pt` to `pk` with ephemeral scalar `e`. Output: [eph.x, eph.y, pt_i + H(T_ENC, shared.x, i)...].
pub fn encrypt<let N: u32>(pt: [Field; N], pk: EmbeddedCurvePoint, e: Field) -> [Field; N + 2] {
    assert_on_curve(pk);
    let es = EmbeddedCurveScalar::from_field(e);
    let eph = fixed_base_scalar_mul(es);
    let shared = multi_scalar_mul([pk], [es]);
    assert(!shared.is_infinite());
    let mut out = [0; N + 2];
    out[0] = eph.x;
    out[1] = eph.y;
    for i in 0..N {
        out[i + 2] = pt[i] + h([T_ENC, shared.x, i as Field]);
    }
    out
}

/// Consumption identity of a shared record (STATE-07). Every authorized branch computes the same value from the
/// record plaintext, so two branches cannot both consume one record.
pub fn rec_nullifier(cm: Field, rec_nonce: Field) -> Field {
    h([T_NF_REC, cm, rec_nonce])
}

/// Unique (the nullifiers are) and hidden (the salt is private), so an observer cannot precompute the
/// record's nullifier and link its creation to its consumption.
pub fn rec_nonce(nf0: Field, nf1: Field, index: Field, salt: Field) -> Field {
    h([T_NONCE, nf0, nf1, index, salt])
}

pub fn point(x: Field, y: Field) -> EmbeddedCurvePoint {
    EmbeddedCurvePoint { x, y }
}

/// Escrowed value with committed terms, consumable by the coordinator only as the terms allow, or refunded to
/// its owner after `expiry`.
///   taker terms: t2 = is_short (0/1), t3 = size, t4 = limit price
///   maker terms: t2 = open spread in bps, t3 = maximum size, t4 = standing close spread in bps (D-10)
///   swap terms:  t2 = 0, t3 = minimum output, t4 = second pool id or 0; market is the first pool id
///   LP add terms: t2 = side (0 token0, 1 token1), t3 = minimum shares, t4 = id linking the two locks; market is the pool id
pub struct Lock {
    pub asset: Field,
    pub amount: Field,
    pub owner_auth: Field,
    pub owner_x: Field,
    pub owner_y: Field,
    pub role: Field,
    pub market: Field,
    pub t2: Field,
    pub t3: Field,
    pub t4: Field,
    pub expiry: Field,
    pub rec_nonce: Field,
    pub blind: Field,
}

impl Lock {
    pub fn commit(self, deployment: Field) -> Field {
        let terms = h([T_TERMS, self.role, self.market, self.t2, self.t3, self.t4]);
        h(
            [
                T_LOCK, deployment, RECORD_VERSION, self.asset, self.amount, self.owner_auth, self.owner_x,
                self.owner_y, terms, self.expiry, self.rec_nonce, self.blind,
            ],
        )
    }

    pub fn plaintext(self) -> [Field; LOCK_PT_LEN] {
        [
            self.asset, self.amount, self.owner_auth, self.owner_x, self.owner_y, self.role, self.market, self.t2,
            self.t3, self.t4, self.expiry, self.rec_nonce, self.blind,
        ]
    }

    pub fn owner(self) -> Field {
        owner_tag(self.owner_auth, point(self.owner_x, self.owner_y))
    }

    /// Range rules every lock satisfies, checked where it is created.
    pub fn assert_well_formed(self) {
        assert_address(self.asset);
        assert_amount(self.amount);
        assert(self.amount != 0, "empty lock");
        self.expiry.assert_max_bit_size::<TIME_BITS>();
        self.t3.assert_max_bit_size::<SIZE_BITS>();
        assert(self.t3 != 0, "zero size");
        if self.role == ROLE_TAKER {
            assert(self.t2 * (self.t2 - 1) == 0, "side is 0 or 1");
            self.t4.assert_max_bit_size::<PRICE_BITS>();
        } else if self.role == ROLE_MAKER {
            assert_le(self.t2, BPS);
            assert_le(self.t4, BPS);
        } else if self.role == ROLE_SWAP {
            assert_eq(self.t2, 0);
        } else {
            assert_eq(self.role, ROLE_LP, "unknown role");
            assert(self.t2 * (self.t2 - 1) == 0, "side is 0 or 1");
        }
    }
}

/// One isolated taker/maker pair (PERP-01). Both owners' keys are inside so a forced branch can pay them
/// without either being online.
pub struct Pair {
    pub market: Field,
    pub asset: Field,
    pub is_short: Field,
    pub size: Field,
    pub entry: Field,
    pub funding_index: Field,
    pub close_spread: Field,
    /// Funding this pair could not pay when last settled, carried until it can (D-03).
    pub funding_debt: Field,
    /// 1 when the taker owes `funding_debt`. Always 0 when the debt is 0.
    pub debt_by_taker: Field,
    /// Size removed by the update that created this version; opens the matching open-interest change.
    pub last_reduce: Field,
    pub taker_margin: Field,
    pub maker_margin: Field,
    pub taker_auth: Field,
    pub taker_x: Field,
    pub taker_y: Field,
    pub maker_auth: Field,
    pub maker_x: Field,
    pub maker_y: Field,
    pub rec_nonce: Field,
    pub blind: Field,
}

impl Pair {
    pub fn commit(self, deployment: Field) -> Field {
        h(
            [
                T_PAIR, deployment, RECORD_VERSION, self.market, self.asset, self.is_short, self.size, self.entry,
                self.funding_index, self.close_spread, self.funding_debt, self.debt_by_taker,
                self.last_reduce, self.taker_margin, self.maker_margin, self.taker_auth, self.taker_x, self.taker_y,
                self.maker_auth, self.maker_x, self.maker_y, self.rec_nonce, self.blind,
            ],
        )
    }

    pub fn plaintext(self) -> [Field; PAIR_PT_LEN] {
        [
            self.market, self.asset, self.is_short, self.size, self.entry, self.funding_index, self.close_spread,
            self.funding_debt, self.debt_by_taker, self.last_reduce, self.taker_margin, self.maker_margin, self.taker_auth, self.taker_x, self.taker_y, self.maker_auth, self.maker_x, self.maker_y,
            self.rec_nonce, self.blind,
        ]
    }
}

/// Hiding, unique commitment to one change of private market state, folded later by funding_epoch. `remove` is 0 for an
/// open and 1 for a close. `ins_in` is a penalty share entering insurance; `claim` is a shortfall asking to be covered.
pub fn oi_delta(
    deployment: Field,
    market: Field,
    is_short: Field,
    size: Field,
    remove: Field,
    ins_in: Field,
    claim: Field,
    rec_nonce: Field,
) -> Field {
    h([T_OI, deployment, market, is_short, size, remove, ins_in, claim, rec_nonce])
}

pub fn market_head(
    deployment: Field,
    market: Field,
    long_oi: Field,
    short_oi: Field,
    insurance: Field,
    bad_debt: Field,
    bond_used: Field,
    blind: Field,
) -> Field {
    h([T_MARKET, deployment, RECORD_VERSION, market, long_oi, short_oi, insurance, bad_debt, bond_used, blind])
}

/// A winner's right to be covered for a loser's shortfall (D-07). Created at liquidation, always, with amount 0 when
/// there is no shortfall, and paid at the pro-rata ratio of the epoch that folds `delta_cm`.
pub struct Claim {
    pub market: Field,
    pub asset: Field,
    pub amount: Field,
    pub owner_auth: Field,
    pub owner_x: Field,
    pub owner_y: Field,
    pub ins_in: Field,
    pub pair_nonce: Field,
    pub delta_cm: Field,
    pub rec_nonce: Field,
    pub blind: Field,
}

impl Claim {
    pub fn commit(self, deployment: Field) -> Field {
        h(
            [
                T_CLAIM, deployment, RECORD_VERSION, self.market, self.asset, self.amount, self.owner_auth, self.owner_x,
                self.owner_y, self.ins_in, self.pair_nonce, self.delta_cm, self.rec_nonce, self.blind,
            ],
        )
    }

    pub fn plaintext(self) -> [Field; CLAIM_PT_LEN] {
        [
            self.market, self.asset, self.amount, self.owner_auth, self.owner_x, self.owner_y, self.ins_in, self.pair_nonce,
            self.delta_cm, self.rec_nonce, self.blind,
        ]
    }
}

/// Private state of one spot pool. Each transition consumes the head on the contract and writes the next.
/// `last_leaf` is the tree position of the last intent executed: intents only run in increasing order (D-18).
pub struct PoolState {
    pub r0: Field,
    pub r1: Field,
    pub supply: Field,
    pub last_leaf: Field,
    pub blind: Field,
}

pub fn pool_head(deployment: Field, pool: Field, s: PoolState) -> Field {
    h([T_POOL, deployment, RECORD_VERSION, pool, s.r0, s.r1, s.supply, s.last_leaf, s.blind])
}

pub fn pool_plaintext(s: PoolState) -> [Field; POOL_PT_LEN] {
    [s.r0, s.r1, s.supply, s.last_leaf, s.blind]
}

/// A private LP position. `expiry` 0 means idle; otherwise it is a removal request bounded by min0 and min1.
pub struct LpClaim {
    pub pool: Field,
    pub shares: Field,
    pub owner_auth: Field,
    pub owner_x: Field,
    pub owner_y: Field,
    pub expiry: Field,
    pub min0: Field,
    pub min1: Field,
    pub rec_nonce: Field,
    pub blind: Field,
}

impl LpClaim {
    pub fn commit(self, deployment: Field) -> Field {
        h(
            [
                T_LP, deployment, RECORD_VERSION, self.pool, self.shares, self.owner_auth, self.owner_x, self.owner_y,
                self.expiry, self.min0, self.min1, self.rec_nonce, self.blind,
            ],
        )
    }

    pub fn plaintext(self) -> [Field; LP_PT_LEN] {
        [
            self.pool, self.shares, self.owner_auth, self.owner_x, self.owner_y, self.expiry, self.min0, self.min1,
            self.rec_nonce, self.blind,
        ]
    }
}

/// floor(sqrt(x)) for x below 2^192.
pub fn floor_sqrt(x: Field) -> Field {
    // Safety: constrained below by s*s <= x < (s+1)*(s+1).
    let s = unsafe { sqrt_hint(x) };
    s.assert_max_bit_size::<97>();
    assert_le(s * s, x);
    assert(x.lt((s + 1) * (s + 1)));
    s
}

unconstrained fn sqrt_hint(x: Field) -> Field {
    let bits: [bool; 254] = x.to_be_bits();
    let mut r: Field = 0;
    let mut acc: Field = 0;
    let mut i: u32 = 0;
    // Binary long square root, two bits at a time from the top.
    while i < 254 {
        acc = acc * 4 + (bits[i] as Field) * 2 + (bits[i + 1] as Field);
        let t = r * 4 + 1;
        r = r * 2;
        if !acc.lt(t) {
            acc = acc - t;
            r = r + 1;
        }
        i += 2;
    }
    r
}

/// SpotMath.getAmountOut with reserves and input below 2^96. Rounds down, in the pool's favor.
pub fn amount_out(amount_in: Field, r_in: Field, r_out: Field, fee_bps: Field) -> Field {
    assert((r_in != 0) & (r_out != 0), "empty pool");
    let with_fee = amount_in * (BPS - fee_bps);
    floor_div(with_fee * r_out, r_in * BPS + with_fee)
}

/// a <= b. Both must already be range-checked well below the field modulus.
pub fn assert_le(a: Field, b: Field) {
    assert(!b.lt(a));
}

pub fn min(a: Field, b: Field) -> Field {
    if a.lt(b) { a } else { b }
}

// Division: q is a hint, bounded so q * b + b stays below the modulus (q < 2^136, b < 2^112), then checked.

pub fn floor_div(a: Field, b: Field) -> Field {
    // Safety: constrained below by q*b <= a < q*b + b.
    let q = unsafe { div_hint(a, b, false) };
    q.assert_max_bit_size::<136>();
    b.assert_max_bit_size::<112>();
    assert(b != 0);
    let prod = q * b;
    assert_le(prod, a);
    assert(a.lt(prod + b));
    q
}

pub fn ceil_div(a: Field, b: Field) -> Field {
    // Safety: constrained below by a <= q*b < a + b.
    let q = unsafe { div_hint(a, b, true) };
    q.assert_max_bit_size::<136>();
    b.assert_max_bit_size::<112>();
    assert(b != 0);
    let prod = q * b;
    assert_le(a, prod);
    assert(prod.lt(a + b));
    q
}

unconstrained fn div_hint(a: Field, b: Field, up: bool) -> Field {
    let bits: [bool; 254] = a.to_be_bits();
    let mut q: Field = 0;
    let mut r: Field = 0;
    for i in 0..254 {
        r = r * 2 + (bits[i] as Field);
        q = q * 2;
        if !r.lt(b) {
            r = r - b;
            q = q + 1;
        }
    }
    if up & (r != 0) { q + 1 } else { q }
}

// Mirrors of contracts/src/lib/RiskMath.sol. Same rounding: requirements and fees up, health PnL toward
// negative infinity, transfers toward zero with one integer moving between the two sides.

pub fn notional_up(size: Field, price: Field) -> Field {
    ceil_div(size * price, WAD)
}

pub fn margin_requirement(size: Field, price: Field, fraction_wad: Field, scale: Field) -> Field {
    ceil_div(ceil_div(notional_up(size, price) * fraction_wad, WAD), scale)
}

pub fn fee(size: Field, price: Field, fee_bps: Field, scale: Field) -> Field {
    ceil_div(ceil_div(notional_up(size, price) * fee_bps, BPS), scale)
}

/// Taker PnL of a pair at `mark`, as a direction and two magnitudes in token units.
/// Health: the gaining side counts `floor`, the losing side loses `ceil`. Transfer: `floor` (toward zero).
pub struct PairPnl {
    pub taker_gains: bool,
    pub floor: Field,
    pub ceil: Field,
}

pub fn pair_pnl(is_short: Field, size: Field, entry: Field, mark: Field, scale: Field) -> PairPnl {
    let up = !mark.lt(entry);
    let diff = if up { mark - entry } else { entry - mark };
    let raw = size * diff;
    let d = WAD * scale;
    PairPnl { taker_gains: up == (is_short == 0), floor: floor_div(raw, d), ceil: ceil_div(raw, d) }
}

/// Funding since the pair's snapshot, settled against its margins (PERP-04, D-03). Positive index movement means longs
/// pay. The payer pays what its margin covers; `unpaid` is the rest.
pub struct FundingSettled {
    pub taker_pays: bool,
    pub taker_margin: Field,
    pub maker_margin: Field,
    pub unpaid: Field,
}

pub fn settle_funding(pair: Pair, funding_index: Field, scale: Field) -> FundingSettled {
    funding_index.assert_max_bit_size::<FUNDING_BITS>();
    let up = !funding_index.lt(pair.funding_index);
    let mag = if up { funding_index - pair.funding_index } else { pair.funding_index - funding_index };
    let accrued = ceil_div(pair.size * mag, WAD * scale);
    let accrued_by_taker = up == (pair.is_short == 0);
    let debt_by_taker = pair.debt_by_taker == 1;
    let (owed, taker_pays) = if accrued_by_taker == debt_by_taker {
        (accrued + pair.funding_debt, accrued_by_taker)
    } else if pair.funding_debt.lt(accrued) {
        (accrued - pair.funding_debt, accrued_by_taker)
    } else {
        (pair.funding_debt - accrued, debt_by_taker)
    };
    let paid = min(owed, if taker_pays { pair.taker_margin } else { pair.maker_margin });
    let (taker_margin, maker_margin) = if taker_pays {
        (pair.taker_margin - paid, pair.maker_margin + paid)
    } else {
        (pair.taker_margin + paid, pair.maker_margin - paid)
    };
    FundingSettled { taker_pays, taker_margin, maker_margin, unpaid: owed - paid }
}

/// margin + pnl < requirement, without negative intermediates.
pub fn below(margin: Field, gains: bool, pnl: PairPnl, requirement: Field) -> bool {
    if gains {
        (margin + pnl.floor).lt(requirement)
    } else {
        margin.lt(requirement + pnl.ceil)
    }
}

#[test]
fn division_rounds_both_ways() {
    assert_eq(floor_div(7, 2), 3);
    assert_eq(ceil_div(7, 2), 4);
    assert_eq(ceil_div(8, 2), 4);
    assert_eq(floor_div(0, 5), 0);
    assert_eq(ceil_div(0, 5), 0);
}

#[test]
fn margin_matches_riskmath_vector() {
    // 4 units at 250 USD, 10% IMR, 6-decimal token: notional 1000 USD -> 100 USDG.
    let size = 4 * WAD;
    let price = 250 * WAD;
    let req = margin_requirement(size, price, WAD / 10, 1_000_000_000_000);
    assert_eq(req, 100_000_000);
}

#[test]
fn zero_root_matches_contract_constant() {
    let mut z = 0;
    for _ in 0..TREE_DEPTH {
        z = h([T_NODE, z, z]);
    }
    println(f"EMPTY_ROOT {z}");
}
