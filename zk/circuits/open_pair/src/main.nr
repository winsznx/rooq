// Coordinator-proved match of a taker LOCK against a maker LOCK into one PAIR record (PERP-01/02 subset).
// Authority comes from the committed lock terms, not from either owner being online: the fill is at the
// contract-supplied oracle mark plus the maker's committed spread, inside the taker's limit and size, the
// maker's maximum size, and initial margin for both sides at the mark.
//
// The pair is encrypted inside the proof to the taker, the maker and both contract-fixed risk keys (LIQ-02,
// LIQ-04, REC-01): the coordinator cannot open a valid position whose risk data the workers cannot read.
// Unused maker backing returns to the maker as a FREE note.
//
// The taker pays the market fee from its lock as a shielded note to the contract-fixed fee address. Open interest is
// bounded against the last folded market record plus a worst case for everything not folded yet. The fill appends a hidden open-interest change that
// funding_epoch folds later (D-08).
use rooq_zk::{
    assert_amount, below, BPS, fee, market_head, notional_up, owner_tag, ceil_div, encrypt, floor_div, FREE_DOMAIN, Lock, margin_requirement,
    FUNDING_BITS, merkle_root, note_commitment, note_inner, NOTE_CT_LEN, oi_delta, output_rho, Pair, PAIR_CT_LEN, pair_pnl, point,
    PRICE_BITS, rec_nonce, rec_nullifier, ROLE_MAKER, ROLE_TAKER, TREE_DEPTH,
};

struct Held {
    lock: Lock,
    index: Field,
    path: [Field; TREE_DEPTH],
}

fn consume(h: Held, root: Field, deployment: Field) -> Field {
    let cm = h.lock.commit(deployment);
    assert_eq(merkle_root(cm, h.index, h.path), root, "lock not in tree");
    rec_nullifier(cm, h.lock.rec_nonce)
}

fn main(
    taker: Held,
    maker: Held,
    maker_margin: Field,
    pair_salt: Field,
    pair_blind: Field,
    pair_eph: [Field; 4],
    refund_blind: Field,
    refund_eph: Field,
    fee_blind: Field,
    fee_eph: Field,
    long_oi: Field,
    short_oi: Field,
    head_insurance: Field,
    head_bad_debt: Field,
    head_bond_used: Field,
    head_blind: Field,
    root: pub Field,
    nf: pub [Field; 2],
    cm_pair: pub Field,
    cm_refund: pub Field,
    ct_pair: pub [[Field; PAIR_CT_LEN]; 4],
    ct_refund: pub [Field; NOTE_CT_LEN],
    deployment: pub Field,
    market: pub Field,
    asset: pub Field,
    mark: pub Field,
    now: pub Field,
    imr_wad: pub Field,
    scale: pub Field,
    risk_pk: pub [[Field; 2]; 2],
    funding_index: pub Field,
    delta_cm: pub Field,
    cm_fee: pub Field,
    ct_fee: pub [Field; NOTE_CT_LEN],
    fee_bps: pub Field,
    fee_auth: pub Field,
    fee_pk: pub [Field; 2],
    head: pub Field,
    oi_pending: pub Field,
    max_oi_usd: pub Field,
    max_pair_size: pub Field,
) {
    let t = taker.lock;
    let m = maker.lock;
    assert_eq(consume(taker, root, deployment), nf[0]);
    assert_eq(consume(maker, root, deployment), nf[1]);
    assert_eq(t.role, ROLE_TAKER);
    assert_eq(m.role, ROLE_MAKER);
    assert_eq(t.market, market);
    assert_eq(m.market, market);
    assert_eq(t.asset, asset);
    assert_eq(m.asset, asset);
    now.assert_max_bit_size::<64>();
    assert(!t.expiry.lt(now), "taker lock expired");
    assert(!m.expiry.lt(now), "maker lock expired");

    mark.assert_max_bit_size::<PRICE_BITS>();
    let is_short = t.t2;
    let size = t.t3;
    let spread = m.t2;
    let fill = if is_short == 0 {
        ceil_div(mark * (BPS + spread), BPS)
    } else {
        floor_div(mark * (BPS - spread), BPS)
    };
    if is_short == 0 {
        assert(!t.t4.lt(fill), "fill above taker limit");
    } else {
        assert(!fill.lt(t.t4), "fill below taker limit");
    }
    assert(!m.t3.lt(size), "size above maker maximum");
    assert(!max_pair_size.lt(size), "size above market maximum");

    if head == 0 {
        assert_eq(long_oi, 0);
        assert_eq(short_oi, 0);
    } else {
        assert_eq(market_head(deployment, market, long_oi, short_oi, head_insurance, head_bad_debt, head_bond_used, head_blind), head, "head mismatch");
    }
    assert_amount(long_oi);
    assert_amount(short_oi);
    oi_pending.assert_max_bit_size::<128>();
    assert(!max_oi_usd.lt(notional_up(long_oi + short_oi + oi_pending + size, mark)), "open interest limit");

    assert_amount(maker_margin);
    assert(!m.amount.lt(maker_margin), "maker margin above lock");
    let taker_fee = fee(size, fill, fee_bps, scale);
    assert(!t.amount.lt(taker_fee), "lock cannot pay the fee");
    let taker_margin = t.amount - taker_fee;
    let im = margin_requirement(size, mark, imr_wad, scale);
    let pnl = pair_pnl(is_short, size, fill, mark, scale);
    assert(!below(taker_margin, pnl.taker_gains, pnl, im), "taker below initial margin");
    assert(!below(maker_margin, !pnl.taker_gains, pnl, im), "maker below initial margin");

    funding_index.assert_max_bit_size::<FUNDING_BITS>();
    let pair = Pair {
        market,
        asset,
        is_short,
        size,
        entry: fill,
        funding_index,
        close_spread: m.t4,
        funding_debt: 0,
        debt_by_taker: 0,
        last_reduce: 0,
        taker_margin,
        maker_margin,
        taker_auth: t.owner_auth,
        taker_x: t.owner_x,
        taker_y: t.owner_y,
        maker_auth: m.owner_auth,
        maker_x: m.owner_x,
        maker_y: m.owner_y,
        rec_nonce: rec_nonce(nf[0], nf[1], 0, pair_salt),
        blind: pair_blind,
    };
    assert_eq(pair.commit(deployment), cm_pair);
    assert_eq(oi_delta(deployment, market, is_short, size, 0, 0, 0, pair.rec_nonce), delta_cm);
    let pt = pair.plaintext();
    let keys = [
        point(t.owner_x, t.owner_y), point(m.owner_x, m.owner_y), point(risk_pk[0][0], risk_pk[0][1]),
        point(risk_pk[1][0], risk_pk[1][1]),
    ];
    for i in 0..4 {
        assert_eq(encrypt(pt, keys[i], pair_eph[i]), ct_pair[i]);
    }

    let refund = m.amount - maker_margin;
    let rho = output_rho(nf[0], nf[1], 1);
    assert_eq(cm_refund, note_commitment(deployment, FREE_DOMAIN, asset, refund, note_inner(m.owner(), rho, refund_blind)));
    assert_eq(encrypt([FREE_DOMAIN, asset, refund, rho, refund_blind], keys[1], refund_eph), ct_refund);

    let fee_key = point(fee_pk[0], fee_pk[1]);
    let fee_rho = output_rho(nf[0], nf[1], 2);
    assert_eq(cm_fee, note_commitment(deployment, FREE_DOMAIN, asset, taker_fee, note_inner(owner_tag(fee_auth, fee_key), fee_rho, fee_blind)));
    assert_eq(encrypt([FREE_DOMAIN, asset, taker_fee, fee_rho, fee_blind], fee_key, fee_eph), ct_fee);
}
