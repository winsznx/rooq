// Whole-circuit executions of the removal price band. The pool sits at P = 4: 1e6 token0 against 4e6 token1, 2e6 shares,
// with accruals the removal must carry untouched.
use crate::main;
use rooq_zk::{
    encrypt, FREE_DOMAIN, h, LpClaim, merkle_root, NOTE_CT_LEN, note_commitment, note_inner, output_rho, owner_tag, POOL_CT_LEN,
    pool_head, pool_plaintext, PoolState, rec_nullifier, T_NODE, TREE_DEPTH, WAD,
};
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul};

global DEPLOYMENT: Field = 31337;
global POOL: Field = 1;
global TOKEN0: Field = 0xa0;
global TOKEN1: Field = 0xa1;
global NOW: Field = 1_000_000;
global INDEX: Field = 4;

fn key(sk: Field) -> EmbeddedCurvePoint {
    fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(sk))
}

/// Removes 2,000 of 2e6 shares, which pays 1,000 token0 and 4,000 token1, from a claim alone in the tree.
fn remove(price_lo: Field, price_hi: Field) {
    let owner = key(12);
    let claim = LpClaim {
        pool: POOL,
        shares: 2_000,
        owner_auth: 16,
        owner_x: owner.x,
        owner_y: owner.y,
        expiry: NOW + 3600,
        price_lo,
        price_hi,
        rec_nonce: 21,
        blind: 22,
    };
    let mut path = [0; TREE_DEPTH];
    let mut z = 0;
    for i in 0..TREE_DEPTH {
        path[i] = z;
        z = h([T_NODE, z, z]);
    }
    let cm = claim.commit(DEPLOYMENT);
    let nf = rec_nullifier(cm, claim.rec_nonce);
    let state = PoolState { r0: 1_000_000, r1: 4_000_000, supply: 2_000_000, last_leaf: 3, proto0: 7, proto1: 9, blind: 41 };
    let (a0, a1) = (1_000, 4_000);
    let next = PoolState {
        r0: state.r0 - a0,
        r1: state.r1 - a1,
        supply: state.supply - claim.shares,
        last_leaf: INDEX + 1,
        proto0: state.proto0,
        proto1: state.proto1,
        blind: 42,
    };
    let k = [key(31), key(32), key(33)];
    let keys = [[k[0].x, k[0].y], [k[1].x, k[1].y], [k[2].x, k[2].y]];
    let pool_eph = [61, 62, 63];
    let mut ct_pool: [[Field; POOL_CT_LEN]; 3] = [[0; POOL_CT_LEN]; 3];
    for i in 0..3 {
        ct_pool[i] = encrypt(pool_plaintext(next), k[i], pool_eph[i]);
    }
    let out_blind = [81, 82];
    let out_eph = [83, 84];
    let outs = [(a0, TOKEN0), (a1, TOKEN1)];
    let mut cm_out = [0; 2];
    let mut ct_out: [[Field; NOTE_CT_LEN]; 2] = [[0; NOTE_CT_LEN]; 2];
    for i in 0..2 {
        let (value, asset) = outs[i];
        let rho = output_rho(nf, 0, i as Field);
        cm_out[i] = note_commitment(DEPLOYMENT, FREE_DOMAIN, asset, value, note_inner(owner_tag(16, owner), rho, out_blind[i]));
        ct_out[i] = encrypt([FREE_DOMAIN, asset, value, rho, out_blind[i]], owner, out_eph[i]);
    }
    main(
        claim,
        INDEX,
        path,
        state,
        42,
        out_blind,
        out_eph,
        pool_eph,
        merkle_root(cm, INDEX, path),
        nf,
        pool_head(DEPLOYMENT, POOL, state),
        pool_head(DEPLOYMENT, POOL, next),
        cm_out,
        ct_out,
        ct_pool,
        DEPLOYMENT,
        NOW,
        POOL,
        TOKEN0,
        TOKEN1,
        keys,
    );
}

#[test]
fn remove_inside_band() {
    remove(3 * WAD, 5 * WAD);
}

#[test]
fn remove_at_both_band_edges() {
    remove(4 * WAD, 4 * WAD);
}

#[test]
fn remove_with_open_ended_bands() {
    remove(0, 5 * WAD);
    remove(3 * WAD, 0xffffffffffffffffffffffffffffffff);
    remove(0, 0xffffffffffffffffffffffffffffffff);
}

#[test(should_fail_with = "price below band")]
fn remove_below_band_refused() {
    remove(4 * WAD + 1, 5 * WAD);
}

#[test(should_fail_with = "price above band")]
fn remove_above_band_refused() {
    remove(3 * WAD, 4 * WAD - 1);
}
