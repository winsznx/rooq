// Rooq private V1 record primitives (docs/privacy/ADR-P02-state-and-notes.md).
// Every tag, field order and hash here is mirrored by packages/private-sdk; change both together and bump
// RECORD_VERSION.
use poseidon::poseidon2::Poseidon2;
use std::embedded_curve_ops::{
    EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul, multi_scalar_mul,
};

pub global RECORD_VERSION: Field = 2;
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
/// LP price bounds. With mixed decimals P = r1 * WAD / r0 can pass 2^96 (6 against 18 decimals reaches 1e34).
pub global PRICE_BAND_BITS: u32 = 128;
/// Band bounds that mean "no bound": a lower bound of 0 and an upper bound of 2^128 - 1.
pub global PRICE_NO_LOWER: Field = 0;
pub global PRICE_NO_UPPER: Field = 0xffffffffffffffffffffffffffffffff;
/// Seconds after each pair cooldown during which only the taker may update, so maker and keyless updates cannot keep
/// replacing the version a taker's reduce or remove was proved against.
pub global TAKER_GRACE: Field = 120;

/// Fields in an encrypted FREE note: domain, asset, value, rho, blind.
pub global NOTE_PT_LEN: u32 = 5;
/// Ciphertext: ephemeral point (x, y) followed by the masked plaintext.
pub global NOTE_CT_LEN: u32 = NOTE_PT_LEN + 2;
pub global LOCK_PT_LEN: u32 = 13;
pub global LOCK_CT_LEN: u32 = LOCK_PT_LEN + 2;
pub global PAIR_PT_LEN: u32 = 21;
pub global PAIR_CT_LEN: u32 = PAIR_PT_LEN + 2;
pub global MARKET_PT_LEN: u32 = 6;
pub global CLAIM_PT_LEN: u32 = 11;
pub global CLAIM_CT_LEN: u32 = CLAIM_PT_LEN + 2;
pub global POOL_PT_LEN: u32 = 7;
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

/// The relay fee: a FREE note in the action's own asset to whoever relays it (M36 spec-fees). Amount and recipient are
/// private and the note is always present, so a zero fee, sent by the wallet to itself, looks the same on chain as a paid
/// one. Turning fees on is then relayer policy, with no redeploy.
pub struct RelayFee {
    pub value: Field,
    pub auth: Field,
    pub pk: EmbeddedCurvePoint,
    pub blind: Field,
    pub eph: Field,
}

impl RelayFee {
    /// Commitment and ciphertext of the fee note. `index` must differ from every other output rho of the circuit.
    pub fn note(
        self,
        deployment: Field,
        asset: Field,
        nf0: Field,
        nf1: Field,
        index: Field,
    ) -> (Field, [Field; NOTE_CT_LEN]) {
        assert_amount(self.value);
        let rho = output_rho(nf0, nf1, index);
        let inner = note_inner(owner_tag(self.auth, self.pk), rho, self.blind);
        let cm = note_commitment(deployment, FREE_DOMAIN, asset, self.value, inner);
        (cm, encrypt([FREE_DOMAIN, asset, self.value, rho, self.blind], self.pk, self.eph))
    }
}

/// The caller still has to take `relay.value` out of something the prover is entitled to, and, on a path that needs no
/// owner key, require that key for a nonzero fee: otherwise a prover holding only the plaintext could pay itself the
/// owner's value.
pub fn relay_fee_note(
    deployment: Field,
    asset: Field,
    relay: RelayFee,
    nf0: Field,
    nf1: Field,
    index: Field,
    cm: Field,
    ct: [Field; NOTE_CT_LEN],
) {
    let (expected_cm, expected_ct) = relay.note(deployment, asset, nf0, nf1, index);
    assert_eq(expected_cm, cm, "wrong relay fee commitment");
    assert_eq(expected_ct, ct, "wrong relay fee ciphertext");
}

/// Escrowed value with committed terms, consumable by the coordinator only as the terms allow, or refunded to
/// its owner after `expiry`.
///   taker terms: t2 = is_short (0/1), t3 = size, t4 = limit price
///   maker terms: t2 = open spread in bps, t3 = maximum size, t4 = standing close spread in bps (D-10)
///   swap terms:  t2 = 0, t3 = minimum output, t4 = second pool id or 0; market is the first pool id
///   LP add terms: t2 = side (0 token0, 1 token1), t3 = price bound (side 0 lowest, side 1 highest accepted P),
///                 t4 = id linking the two locks; market is the pool id
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
        if self.role == ROLE_LP {
            self.t3.assert_max_bit_size::<PRICE_BAND_BITS>();
            // Side 0 carries the band's lower bound, where 0 means none. Side 1's upper bound is never 0.
            assert((self.t3 != 0) | (self.t2 == 0), "empty band");
        } else {
            self.t3.assert_max_bit_size::<SIZE_BITS>();
            assert(self.t3 != 0, "zero size");
        }
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
    /// When this version was created. The next update must wait out the contract's cooldown from here.
    pub updated_at: Field,
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
                self.last_reduce, self.updated_at, self.taker_margin, self.maker_margin, self.taker_auth, self.taker_x, self.taker_y,
                self.maker_auth, self.maker_x, self.maker_y, self.rec_nonce, self.blind,
            ],
        )
    }

    pub fn plaintext(self) -> [Field; PAIR_PT_LEN] {
        [
            self.market, self.asset, self.is_short, self.size, self.entry, self.funding_index, self.close_spread,
            self.funding_debt, self.debt_by_taker, self.last_reduce, self.updated_at, self.taker_margin, self.maker_margin,
            self.taker_auth, self.taker_x, self.taker_y, self.maker_auth, self.maker_x, self.maker_y, self.rec_nonce, self.blind,
        ]
    }
}

/// Open-interest change kinds. A close and a liquidation of one version share its nullifier, so they can share a kind;
/// a reduce gets its own, because its size can equal the next version's whole size under the same nonce.
pub global OI_OPEN: Field = 0;
pub global OI_CLOSE: Field = 1;
pub global OI_REDUCE: Field = 2;

/// Hiding, unique commitment to one change of private market state, folded later by funding_epoch. `kind` is one of the
/// OI_ kinds. `ins_in` is a penalty share entering insurance; `claim` is a shortfall asking to be covered.
pub fn oi_delta(
    deployment: Field,
    market: Field,
    is_short: Field,
    size: Field,
    kind: Field,
    ins_in: Field,
    claim: Field,
    rec_nonce: Field,
) -> Field {
    h([T_OI, deployment, market, is_short, size, kind, ins_in, claim, rec_nonce])
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
/// `last_leaf` is the tree position of the last intent executed: intents only run in increasing order (D-18). This orders
/// execution; it doesn't stop front-running.
/// `proto0`/`proto1` are the protocol's share of swap fees, held in custody beside the reserves but never counted as them.
pub struct PoolState {
    pub r0: Field,
    pub r1: Field,
    pub supply: Field,
    pub last_leaf: Field,
    pub proto0: Field,
    pub proto1: Field,
    pub blind: Field,
}

pub fn pool_head(deployment: Field, pool: Field, s: PoolState) -> Field {
    h([T_POOL, deployment, RECORD_VERSION, pool, s.r0, s.r1, s.supply, s.last_leaf, s.proto0, s.proto1, s.blind])
}

pub fn pool_plaintext(s: PoolState) -> [Field; POOL_PT_LEN] {
    [s.r0, s.r1, s.supply, s.last_leaf, s.proto0, s.proto1, s.blind]
}

/// lo <= r1 * WAD / r0 <= hi, by cross-multiplication so it is exact at both edges. r0, r1 < 2^96 and lo, hi < 2^128, so
/// both sides stay under 2^224. PRICE_NO_LOWER and PRICE_NO_UPPER skip their side, so a band can cover prices whose raw
/// ratio falls below 1e-18 or past 2^128 / 1e18.
pub fn assert_price_in_band(r0: Field, r1: Field, lo: Field, hi: Field) {
    if lo != PRICE_NO_LOWER {
        assert(!(r1 * WAD).lt(lo * r0), "price below band");
    }
    if hi != PRICE_NO_UPPER {
        assert(!(hi * r0).lt(r1 * WAD), "price above band");
    }
}

/// The protocol's part of a swap fee, rounded down. It never exceeds the fee `amount_out` already withheld, so taking it out
/// of the input reserve leaves k non-decreasing.
pub fn protocol_cut(amount_in: Field, fee_bps: Field, protocol_bps: Field) -> Field {
    assert_le(protocol_bps, BPS);
    floor_div(amount_in * fee_bps * protocol_bps, BPS * BPS)
}

/// A private LP position. `expiry` 0 means idle; otherwise it is a removal request that runs only while the pool price is
/// within [price_lo, price_hi].
pub struct LpClaim {
    pub pool: Field,
    pub shares: Field,
    pub owner_auth: Field,
    pub owner_x: Field,
    pub owner_y: Field,
    pub expiry: Field,
    pub price_lo: Field,
    pub price_hi: Field,
    pub rec_nonce: Field,
    pub blind: Field,
}

impl LpClaim {
    pub fn commit(self, deployment: Field) -> Field {
        h(
            [
                T_LP, deployment, RECORD_VERSION, self.pool, self.shares, self.owner_auth, self.owner_x, self.owner_y,
                self.expiry, self.price_lo, self.price_hi, self.rec_nonce, self.blind,
            ],
        )
    }

    pub fn plaintext(self) -> [Field; LP_PT_LEN] {
        [
            self.pool, self.shares, self.owner_auth, self.owner_x, self.owner_y, self.expiry, self.price_lo, self.price_hi,
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

pub struct Health {
    pub taker_bad: bool,
    pub maker_bad: bool,
    pub pnl: PairPnl,
}

/// The liquidation predicate, shared so that an update can never leave behind a version liquidate would accept.
/// `s` is settle_funding(pair, funding_index, scale): unpaid funding counts against its payer.
pub fn maintenance(pair: Pair, s: FundingSettled, mark: Field, mmr_wad: Field, scale: Field) -> Health {
    let mm = margin_requirement(pair.size, mark, mmr_wad, scale);
    let pnl = pair_pnl(pair.is_short, pair.size, pair.entry, mark, scale);
    let taker_required = if s.taker_pays { mm + s.unpaid } else { mm };
    let maker_required = if s.taker_pays { mm } else { mm + s.unpaid };
    Health {
        taker_bad: below(s.taker_margin, pnl.taker_gains, pnl, taker_required),
        maker_bad: below(s.maker_margin, !pnl.taker_gains, pnl, maker_required),
        pnl,
    }
}

/// One side below initial margin `im`, given both margins after the change. Gains count only up to what the
/// counterparty has posted, so a side cannot certify itself with PnL the other side cannot pay.
pub fn side_below_im(
    taker_side: bool,
    taker_margin: Field,
    maker_margin: Field,
    taker_pays: bool,
    unpaid: Field,
    h: PairPnl,
    im: Field,
) -> bool {
    if taker_side {
        let certified = PairPnl { taker_gains: h.taker_gains, floor: min(h.floor, maker_margin), ceil: h.ceil };
        let required = if taker_pays { im + unpaid } else { im };
        below(taker_margin, h.taker_gains, certified, required)
    } else {
        let certified = PairPnl { taker_gains: h.taker_gains, floor: min(h.floor, taker_margin), ceil: h.ceil };
        let required = if taker_pays { im } else { im + unpaid };
        below(maker_margin, !h.taker_gains, certified, required)
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

#[test]
fn zero_relay_fee_to_self_is_shaped_like_a_paid_one() {
    let user = fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(11));
    let relayer = fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(12));
    let free = RelayFee { value: 0, auth: auth_key(11), pk: user, blind: 3, eph: 4 };
    let paid = RelayFee { value: 500, auth: auth_key(12), pk: relayer, blind: 5, eph: 6 };
    let (free_cm, free_ct) = free.note(1, 0xa0, 7, 8, 2);
    let (paid_cm, paid_ct) = paid.note(1, 0xa0, 7, 8, 2);
    relay_fee_note(1, 0xa0, free, 7, 8, 2, free_cm, free_ct);
    relay_fee_note(1, 0xa0, paid, 7, 8, 2, paid_cm, paid_ct);
    assert(free_cm != paid_cm);
    // A zero note hides like any other: no plaintext slot comes out as its own value, and the ephemeral key is a real point.
    for i in 2..NOTE_CT_LEN {
        assert(free_ct[i] != 0);
        assert(free_ct[i] != paid_ct[i]);
    }
    assert_on_curve(point(free_ct[0], free_ct[1]));
    assert_on_curve(point(paid_ct[0], paid_ct[1]));
}

#[test(should_fail)]
fn relay_fee_rejects_an_amount_past_100_bits() {
    let relayer = fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(12));
    let _ = RelayFee { value: 0x10000000000000000000000000, auth: 1, pk: relayer, blind: 5, eph: 6 }.note(1, 0xa0, 7, 8, 2);
}

#[test]
fn oi_reduce_and_close_never_collide() {
    // A reduce that leaves `s` and a later close of that version, under the same nonce.
    let s = 3 * WAD;
    assert(oi_delta(1, 2, 0, s, OI_REDUCE, 0, 0, 99) != oi_delta(1, 2, 0, s, OI_CLOSE, 0, 0, 99));
}

global FUNDING_ZERO: Field = 0x100000000000000000000000000000000;

/// The taker-bad privateLiquidation vector the audit used for finding #4 (risk_vectors.json): a long, 6-decimal asset.
fn audit_vector_pair(taker_margin: Field) -> Pair {
    Pair {
        market: 1,
        asset: 2,
        is_short: 0,
        size: 1674684457435445934250,
        entry: 1415469257951605558794,
        funding_index: FUNDING_ZERO - 1428345306688630161,
        close_spread: 125,
        funding_debt: 0,
        debt_by_taker: 0,
        last_reduce: 0,
        updated_at: 0,
        taker_margin,
        maker_margin: 740564022525,
        taker_auth: 0,
        taker_x: 0,
        taker_y: 0,
        maker_auth: 0,
        maker_x: 0,
        maker_y: 0,
        rec_nonce: 0,
        blind: 0,
    }
}

global AUDIT_MARK: Field = 1321758914295174516771;
global AUDIT_MMR: Field = 44472916527213500;
global AUDIT_SCALE: Field = 1_000_000_000_000;
global AUDIT_INDEX: Field = FUNDING_ZERO + 38310824544062406996;

#[test]
fn maintenance_matches_liquidation_vector() {
    let pair = audit_vector_pair(3295917909);
    let s = settle_funding(pair, AUDIT_INDEX, AUDIT_SCALE);
    assert(s.taker_pays);
    assert_eq(s.taker_margin, 0);
    assert_eq(s.unpaid, 63254652192);
    let hl = maintenance(pair, s, AUDIT_MARK, AUDIT_MMR, AUDIT_SCALE);
    assert(hl.taker_bad);
    assert(!hl.maker_bad);
    assert(!hl.pnl.taker_gains);
}

#[test]
fn maintenance_healthy_after_cure() {
    // accrued funding 66550570101 + maintenance 98442095351 + loss 156935256023: the smallest healthy taker margin.
    let enough = 321927921475;
    let cured = audit_vector_pair(enough);
    let hl = maintenance(cured, settle_funding(cured, AUDIT_INDEX, AUDIT_SCALE), AUDIT_MARK, AUDIT_MMR, AUDIT_SCALE);
    assert(!hl.taker_bad);
    assert(!hl.maker_bad);
    let short = audit_vector_pair(enough - 1);
    let hl = maintenance(short, settle_funding(short, AUDIT_INDEX, AUDIT_SCALE), AUDIT_MARK, AUDIT_MMR, AUDIT_SCALE);
    assert(hl.taker_bad);
}

#[test]
fn side_below_im_matches_removal_check() {
    let scale = 1_000_000_000_000;
    let size = 4 * WAD;
    // Flat: 4 units at 250, 10% IMR, so IM is exactly 100 USDG.
    let im = margin_requirement(size, 250 * WAD, WAD / 10, scale);
    assert_eq(im, 100_000_000);
    let flat = pair_pnl(0, size, 250 * WAD, 250 * WAD, scale);
    let big = 1_000_000_000_000;
    assert(!side_below_im(true, im, big, false, 0, flat, im));
    assert(!side_below_im(true, im + 1, big, false, 0, flat, im));
    assert(side_below_im(true, im - 1, big, false, 0, flat, im));
    // The payer of unpaid funding needs IM plus that debt; the other side does not.
    assert(side_below_im(false, big, im + 6, false, 7, flat, im));
    assert(!side_below_im(false, big, im + 7, false, 7, flat, im));
    assert(!side_below_im(true, im, big, false, 7, flat, im));

    // Taker up 40 USDG at 260, IM 104 USDG, but the maker posted only 10: the gain counts as 10.
    let im = margin_requirement(size, 260 * WAD, WAD / 10, scale);
    assert_eq(im, 104_000_000);
    let up = pair_pnl(0, size, 250 * WAD, 260 * WAD, scale);
    assert(!side_below_im(true, 94_000_000, 10_000_000, false, 0, up, im));
    assert(side_below_im(true, 93_999_999, 10_000_000, false, 0, up, im));
    // The losing maker needs IM plus its 40 USDG loss.
    assert(!side_below_im(false, big, 144_000_000, false, 0, up, im));
    assert(side_below_im(false, big, 143_999_999, false, 0, up, im));
}

// Pool at P = 4: 1e6 token0 against 4e6 token1.
global BAND_R0: Field = 1_000_000;
global BAND_R1: Field = 4_000_000;

#[test]
fn price_band_accepts_both_edges() {
    assert_price_in_band(BAND_R0, BAND_R1, 4 * WAD, 4 * WAD);
    assert_price_in_band(BAND_R0, BAND_R1, 3 * WAD, 4 * WAD);
    assert_price_in_band(BAND_R0, BAND_R1, 4 * WAD, 5 * WAD);
}

#[test(should_fail_with = "price below band")]
fn price_band_rejects_one_below() {
    assert_price_in_band(BAND_R0, BAND_R1, 4 * WAD + 1, 5 * WAD);
}

#[test(should_fail_with = "price above band")]
fn price_band_rejects_one_above() {
    assert_price_in_band(BAND_R0, BAND_R1, 3 * WAD, 4 * WAD - 1);
}

#[test]
fn price_band_handles_6_vs_18_decimals() {
    // 1e6 of a 6-decimal token0 against 1e10 of an 18-decimal token1 worth 1e-4 of it: P = 1e34, past 2^96.
    let (r0, r1) = (1_000_000_000_000, 10_000_000_000_000_000_000_000_000_000);
    let p = 10_000_000_000_000_000_000_000_000_000_000_000;
    r1.assert_max_bit_size::<RESERVE_BITS>();
    assert(!p.lt(0x1000000000000000000000000));
    p.assert_max_bit_size::<PRICE_BAND_BITS>();
    assert_price_in_band(r0, r1, p, p);
    assert_price_in_band(r0, r1, p - 1, p + 1);
}

#[test]
fn protocol_cut_is_zero_at_zero_share() {
    assert_eq(protocol_cut(0xffffffffffffffffffffffff, 9_999, 0), 0);
}

#[test]
fn protocol_cut_rounds_down() {
    // 10,000 in at 30 bps with a 2,500 bps share: 7.5 rounds to 7.
    assert_eq(protocol_cut(10_000, 30, 2_500), 7);
    assert_eq(protocol_cut(10_000, 30, BPS), 30);
    assert_eq(protocol_cut(333, 30, 2_500), 0);
}

#[test(should_fail)]
fn protocol_cut_rejects_share_above_bps() {
    let _ = protocol_cut(10_000, 30, BPS + 1);
}

#[test]
fn k_never_drops_with_max_share() {
    let fee_bps = 30;
    let mut r_in = BAND_R0;
    let mut r_out = BAND_R1;
    for amount_in in [1, 333, 10_000, 999_999, 7_000_000] {
        let out = amount_out(amount_in, r_in, r_out, fee_bps);
        let cut = protocol_cut(amount_in, fee_bps, BPS);
        let (next_in, next_out) = (r_in + amount_in - cut, r_out - out);
        assert_le(r_in * r_out, next_in * next_out);
        r_in = next_out;
        r_out = next_in;
    }
}

#[test]
fn open_ended_band_covers_a_sub_wad_price() {
    // 1e28 of an 18-decimal token0 against 1e3 units of a 6-decimal token1: P = 1e-7 in raw WAD, below any nonzero lo.
    assert_price_in_band(10_000_000_000_000_000_000_000_000_000, 1_000, PRICE_NO_LOWER, PRICE_NO_UPPER);
    assert_price_in_band(10_000_000_000_000_000_000_000_000_000, 1_000, PRICE_NO_LOWER, 1);
}

#[test(should_fail_with = "price below band")]
fn smallest_nonzero_lower_bound_still_excludes_a_sub_wad_price() {
    assert_price_in_band(10_000_000_000_000_000_000_000_000_000, 1_000, 1, PRICE_NO_UPPER);
}

#[test]
fn open_ended_band_covers_a_price_past_128_bits() {
    // 1 unit of token0 against 2^96 - 1 of token1: P = (2^96 - 1) * 1e18, past 2^128.
    let r1 = 0xffffffffffffffffffffffff;
    assert(PRICE_NO_UPPER.lt(r1 * WAD));
    assert_price_in_band(1, r1, PRICE_NO_LOWER, PRICE_NO_UPPER);
    assert_price_in_band(1, r1, WAD, PRICE_NO_UPPER);
}

#[test(should_fail_with = "price above band")]
fn widest_closed_upper_bound_still_excludes_a_price_past_128_bits() {
    assert_price_in_band(1, 0xffffffffffffffffffffffff, PRICE_NO_LOWER, PRICE_NO_UPPER - 1);
}
