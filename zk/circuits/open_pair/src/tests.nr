// Whole-circuit executions of the close spread cap and the updated_at stamp. A long of 4 units at mark 250 on a
// 6-decimal asset, filled at the maker's 10 bps open spread.
use crate::{Held, main};
use rooq_zk::{
    auth_key, BPS, ceil_div, encrypt, fee, FREE_DOMAIN, h, Lock, merkle_root, note_commitment, note_inner, NOTE_CT_LEN,
    OI_OPEN, oi_delta, output_rho, owner_tag, Pair, PAIR_CT_LEN, point, rec_nonce, rec_nullifier, ROLE_MAKER, ROLE_TAKER,
    T_NODE, TREE_DEPTH, WAD,
};
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul};

global DEPLOYMENT: Field = 31337;
global MARKET: Field = 1;
global ASSET: Field = 0xa0;
global SCALE: Field = 1_000_000_000_000;
global MARK: Field = 250 * WAD;
global SIZE: Field = 4 * WAD;
global NOW: Field = 1_000_000;
global FEE_BPS: Field = 10;
global FUNDING_ZERO: Field = 0x100000000000000000000000000000000;
global USDG: Field = 1_000_000;
global CAP: Field = 50;

fn key(sk: Field) -> EmbeddedCurvePoint {
    fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(sk))
}

fn lock(sk: Field, role: Field, amount: Field, t2: Field, t3: Field, t4: Field, nonce: Field) -> Lock {
    let pk = key(sk);
    Lock {
        asset: ASSET,
        amount,
        owner_auth: auth_key(sk),
        owner_x: pk.x,
        owner_y: pk.y,
        role,
        market: MARKET,
        t2,
        t3,
        t4,
        expiry: NOW + 3600,
        rec_nonce: nonce,
        blind: nonce + 1,
    }
}

fn two_leaf_paths(a: Field, b: Field) -> ([Field; TREE_DEPTH], [Field; TREE_DEPTH]) {
    let mut pa = [0; TREE_DEPTH];
    let mut pb = [0; TREE_DEPTH];
    pa[0] = b;
    pb[0] = a;
    let mut z = 0;
    for i in 1..TREE_DEPTH {
        z = h([T_NODE, z, z]);
        pa[i] = z;
        pb[i] = z;
    }
    (pa, pb)
}

fn open(close_spread: Field, max_close_spread: Field) {
    let t = lock(11, ROLE_TAKER, 200 * USDG, 0, SIZE, 300 * WAD, 3);
    let m = lock(22, ROLE_MAKER, 300 * USDG, 10, 10 * WAD, close_spread, 5);
    let (tcm, mcm) = (t.commit(DEPLOYMENT), m.commit(DEPLOYMENT));
    let (tpath, mpath) = two_leaf_paths(tcm, mcm);
    let root = merkle_root(tcm, 0, tpath);
    let nf = [rec_nullifier(tcm, t.rec_nonce), rec_nullifier(mcm, m.rec_nonce)];

    let fill = ceil_div(MARK * (BPS + m.t2), BPS);
    let taker_fee = fee(SIZE, fill, FEE_BPS, SCALE);
    let maker_margin = 150 * USDG;
    let pair = Pair {
        market: MARKET,
        asset: ASSET,
        is_short: 0,
        size: SIZE,
        entry: fill,
        funding_index: FUNDING_ZERO,
        close_spread,
        funding_debt: 0,
        debt_by_taker: 0,
        last_reduce: 0,
        updated_at: NOW,
        taker_margin: t.amount - taker_fee,
        maker_margin,
        taker_auth: t.owner_auth,
        taker_x: t.owner_x,
        taker_y: t.owner_y,
        maker_auth: m.owner_auth,
        maker_x: m.owner_x,
        maker_y: m.owner_y,
        rec_nonce: rec_nonce(nf[0], nf[1], 0, 41),
        blind: 42,
    };

    let risk = [key(101), key(102)];
    let fee_pk = key(103);
    let fee_auth = 104;
    let keys = [point(t.owner_x, t.owner_y), point(m.owner_x, m.owner_y), risk[0], risk[1]];
    let pair_eph = [51, 52, 53, 54];
    let mut ct_pair = [[0; PAIR_CT_LEN]; 4];
    for i in 0..4 {
        ct_pair[i] = encrypt(pair.plaintext(), keys[i], pair_eph[i]);
    }
    let refund = m.amount - maker_margin;
    let rho = output_rho(nf[0], nf[1], 1);
    let fee_rho = output_rho(nf[0], nf[1], 2);
    let ct_refund: [Field; NOTE_CT_LEN] = encrypt([FREE_DOMAIN, ASSET, refund, rho, 61], keys[1], 62);
    let ct_fee: [Field; NOTE_CT_LEN] = encrypt([FREE_DOMAIN, ASSET, taker_fee, fee_rho, 63], fee_pk, 64);

    main(
        Held { lock: t, index: 0, path: tpath },
        Held { lock: m, index: 1, path: mpath },
        maker_margin,
        41,
        42,
        pair_eph,
        61,
        62,
        63,
        64,
        0,
        0,
        0,
        0,
        0,
        0,
        root,
        nf,
        pair.commit(DEPLOYMENT),
        note_commitment(DEPLOYMENT, FREE_DOMAIN, ASSET, refund, note_inner(m.owner(), rho, 61)),
        ct_pair,
        ct_refund,
        DEPLOYMENT,
        MARKET,
        ASSET,
        MARK,
        NOW,
        WAD / 10,
        SCALE,
        [[risk[0].x, risk[0].y], [risk[1].x, risk[1].y]],
        FUNDING_ZERO,
        oi_delta(DEPLOYMENT, MARKET, 0, SIZE, OI_OPEN, 0, 0, pair.rec_nonce),
        note_commitment(DEPLOYMENT, FREE_DOMAIN, ASSET, taker_fee, note_inner(owner_tag(fee_auth, fee_pk), fee_rho, 63)),
        ct_fee,
        FEE_BPS,
        fee_auth,
        [fee_pk.x, fee_pk.y],
        0,
        0,
        1_000_000 * WAD,
        100 * WAD,
        max_close_spread,
    );
}

#[test]
fn close_spread_at_the_market_cap() {
    open(CAP, CAP);
}

#[test(should_fail_with = "close spread above market cap")]
fn close_spread_above_the_market_cap() {
    open(CAP + 1, CAP);
}

#[test(should_fail_with = "close spread above market cap")]
fn zero_cap_refuses_any_close_spread() {
    open(1, 0);
}
