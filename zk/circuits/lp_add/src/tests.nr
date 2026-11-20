// Whole-circuit executions of the LP price band and lock adjacency. The seeded pool sits at P = 4: 1e6 token0 against 4e6
// token1, 2e6 shares, with accruals the add must carry untouched.
use crate::{Held, main};
use rooq_zk::{
    encrypt, FREE_DOMAIN, h, Lock, LP_CT_LEN, LpClaim, NOTE_CT_LEN, note_commitment, note_inner, output_rho, point,
    POOL_CT_LEN, pool_head, pool_plaintext, PoolState, rec_nonce, rec_nullifier, ROLE_LP, T_NODE, TREE_DEPTH, WAD,
};
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul};

global DEPLOYMENT: Field = 31337;
global POOL: Field = 1;
global TOKEN0: Field = 0xa0;
global TOKEN1: Field = 0xa1;
global NOW: Field = 1_000_000;
global LINK: Field = 77;

fn key(sk: Field) -> EmbeddedCurvePoint {
    fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(sk))
}

fn pool_keys() -> [[Field; 2]; 3] {
    let k = [key(31), key(32), key(33)];
    [[k[0].x, k[0].y], [k[1].x, k[1].y], [k[2].x, k[2].y]]
}

fn seeded() -> PoolState {
    PoolState { r0: 1_000_000, r1: 4_000_000, supply: 2_000_000, last_leaf: 3, proto0: 7, proto1: 9, blind: 41 }
}

fn fresh() -> PoolState {
    PoolState { r0: 0, r1: 0, supply: 0, last_leaf: 0, proto0: 0, proto1: 0, blind: 0 }
}

/// Root and paths of a tree holding only leaves `a` at `ia` and `b` at `ib`.
fn two_leaf_tree(a: Field, ia: u32, b: Field, ib: u32) -> (Field, [Field; TREE_DEPTH], [Field; TREE_DEPTH]) {
    let (mut na, mut nb, mut pa, mut pb, mut z) = (a, b, ia, ib, 0);
    let mut path_a = [0; TREE_DEPTH];
    let mut path_b = [0; TREE_DEPTH];
    for i in 0..TREE_DEPTH {
        let siblings = (pa ^ 1) == pb;
        path_a[i] = if siblings { nb } else { z };
        path_b[i] = if siblings { na } else { z };
        na = if pa % 2 == 1 { h([T_NODE, path_a[i], na]) } else { h([T_NODE, na, path_a[i]]) };
        nb = if pb % 2 == 1 { h([T_NODE, path_b[i], nb]) } else { h([T_NODE, nb, path_b[i]]) };
        pa /= 2;
        pb /= 2;
        z = h([T_NODE, z, z]);
    }
    (na, path_a, path_b)
}

fn lp_lock(side: Field, amount: Field, bound: Field, nonce: Field) -> Lock {
    let owner = key(12);
    Lock {
        asset: if side == 0 { TOKEN0 } else { TOKEN1 },
        amount,
        owner_auth: 16,
        owner_x: owner.x,
        owner_y: owner.y,
        role: ROLE_LP,
        market: POOL,
        t2: side,
        t3: bound,
        t4: LINK,
        expiry: NOW + 3600,
        rec_nonce: nonce,
        blind: nonce + 1,
    }
}

/// Runs lp_add with locks at tree indices `i0` and `i1`, expecting `used` taken from the deposits and `shares` minted.
fn add(state: PoolState, deposit: [Field; 2], band: [Field; 2], i0: u32, i1: u32, used: [Field; 2], shares: Field) {
    let (a, b) = (lp_lock(0, deposit[0], band[0], 51), lp_lock(1, deposit[1], band[1], 53));
    let (root, path0, path1) = two_leaf_tree(a.commit(DEPLOYMENT), i0, b.commit(DEPLOYMENT), i1);
    let nf = [rec_nullifier(a.commit(DEPLOYMENT), a.rec_nonce), rec_nullifier(b.commit(DEPLOYMENT), b.rec_nonce)];
    let head = if state.supply == 0 { 0 } else { pool_head(DEPLOYMENT, POOL, state) };
    let supply = if state.supply == 0 { shares + 1000 } else { state.supply + shares };
    let next = PoolState {
        r0: state.r0 + used[0],
        r1: state.r1 + used[1],
        supply,
        last_leaf: i1 as Field + 1,
        proto0: state.proto0,
        proto1: state.proto1,
        blind: 42,
    };
    let keys = pool_keys();
    let pool_eph = [61, 62, 63];
    let plain = pool_plaintext(next);
    let mut ct_pool: [[Field; POOL_CT_LEN]; 3] = [[0; POOL_CT_LEN]; 3];
    for i in 0..3 {
        ct_pool[i] = encrypt(plain, point(keys[i][0], keys[i][1]), pool_eph[i]);
    }

    let owner_key = point(a.owner_x, a.owner_y);
    let claim = LpClaim {
        pool: POOL,
        shares,
        owner_auth: a.owner_auth,
        owner_x: a.owner_x,
        owner_y: a.owner_y,
        expiry: 0,
        price_lo: 0,
        price_hi: 0,
        rec_nonce: rec_nonce(nf[0], nf[1], 0, 71),
        blind: 72,
    };
    let lp_eph = [73, 74, 75, 76];
    let lp_keys = [owner_key, point(keys[0][0], keys[0][1]), point(keys[1][0], keys[1][1]), point(keys[2][0], keys[2][1])];
    let mut ct_lp: [[Field; LP_CT_LEN]; 4] = [[0; LP_CT_LEN]; 4];
    for i in 0..4 {
        ct_lp[i] = encrypt(claim.plaintext(), lp_keys[i], lp_eph[i]);
    }

    let refund_blind = [81, 82];
    let refund_eph = [83, 84];
    let tokens = [TOKEN0, TOKEN1];
    let mut cm_refund = [0; 2];
    let mut ct_refund: [[Field; NOTE_CT_LEN]; 2] = [[0; NOTE_CT_LEN]; 2];
    for i in 0..2 {
        let value = deposit[i] - used[i];
        let rho = output_rho(nf[0], nf[1], i as Field);
        cm_refund[i] = note_commitment(DEPLOYMENT, FREE_DOMAIN, tokens[i], value, note_inner(a.owner(), rho, refund_blind[i]));
        ct_refund[i] = encrypt([FREE_DOMAIN, tokens[i], value, rho, refund_blind[i]], owner_key, refund_eph[i]);
    }

    main(
        Held { lock: a, index: i0 as Field, path: path0 },
        Held { lock: b, index: i1 as Field, path: path1 },
        state,
        42,
        71,
        72,
        lp_eph,
        refund_blind,
        refund_eph,
        pool_eph,
        root,
        nf,
        head,
        pool_head(DEPLOYMENT, POOL, next),
        claim.commit(DEPLOYMENT),
        ct_lp,
        cm_refund,
        ct_refund,
        ct_pool,
        DEPLOYMENT,
        NOW,
        POOL,
        TOKEN0,
        TOKEN1,
        keys,
    );
}

/// 1,000 token0 and 5,000 token1 into the seeded pool: 4,000 token1 is used, 1,000 refunds, 2,000 shares.
fn add_to_seeded(band: [Field; 2]) {
    add(seeded(), [1_000, 5_000], band, 4, 5, [1_000, 4_000], 2_000);
}

#[test]
fn add_inside_band_accepted() {
    add_to_seeded([3 * WAD, 5 * WAD]);
}

#[test]
fn add_at_both_band_edges_accepted() {
    add_to_seeded([4 * WAD, 4 * WAD]);
}

#[test]
fn add_with_open_ended_bands_accepted() {
    add_to_seeded([0, 5 * WAD]);
    add_to_seeded([3 * WAD, 0xffffffffffffffffffffffffffffffff]);
    add_to_seeded([0, 0xffffffffffffffffffffffffffffffff]);
}

#[test(should_fail_with = "price below band")]
fn add_below_band_refused() {
    add_to_seeded([4 * WAD + 1, 5 * WAD]);
}

#[test(should_fail_with = "price above band")]
fn add_above_band_refused() {
    add_to_seeded([3 * WAD, 4 * WAD - 1]);
}

#[test]
fn add_to_fresh_pool_uses_depositor_ratio() {
    add(fresh(), [1_000_000, 4_000_000], [4 * WAD, 4 * WAD], 0, 1, [1_000_000, 4_000_000], 1_999_000);
}

#[test(should_fail_with = "price above band")]
fn add_to_fresh_pool_outside_depositor_ratio_refused() {
    add(fresh(), [1_000_000, 4_000_000], [WAD, 2 * WAD], 0, 1, [1_000_000, 4_000_000], 1_999_000);
}

#[test(should_fail_with = "LP locks not adjacent")]
fn add_with_leaf_gap_of_two_refused() {
    add(seeded(), [1_000, 5_000], [3 * WAD, 5 * WAD], 4, 6, [1_000, 4_000], 2_000);
}

#[test(should_fail_with = "LP locks not adjacent")]
fn add_with_locks_in_reverse_order_refused() {
    add(seeded(), [1_000, 5_000], [3 * WAD, 5 * WAD], 5, 4, [1_000, 4_000], 2_000);
}

#[test(should_fail_with = "fresh pool has state")]
fn add_to_fresh_pool_with_accruals_refused() {
    let state = PoolState { r0: 0, r1: 0, supply: 0, last_leaf: 0, proto0: 5, proto1: 0, blind: 0 };
    add(state, [1_000_000, 4_000_000], [4 * WAD, 4 * WAD], 0, 1, [1_000_000, 4_000_000], 1_999_000);
}
