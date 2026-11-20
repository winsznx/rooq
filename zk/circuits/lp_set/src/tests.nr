// Whole-circuit executions of the removal request's price band checks.
use crate::main;
use rooq_zk::{auth_key, encrypt, h, LP_CT_LEN, LpClaim, merkle_root, rec_nonce, rec_nullifier, T_NODE, TREE_DEPTH, WAD};
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul};

global DEPLOYMENT: Field = 31337;
global NOW: Field = 1_000_000;
global SK: Field = 11;
global MAX_BAND: Field = 0xffffffffffffffffffffffffffffffff;

fn key(sk: Field) -> EmbeddedCurvePoint {
    fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(sk))
}

/// Mode 0 on an idle claim alone in the tree at leaf 0.
fn request(price_lo: Field, price_hi: Field) {
    let owner = key(SK);
    let claim = LpClaim {
        pool: 1,
        shares: 2_000,
        owner_auth: auth_key(SK),
        owner_x: owner.x,
        owner_y: owner.y,
        expiry: 0,
        price_lo: 0,
        price_hi: 0,
        rec_nonce: 21,
        blind: 22,
    };
    let mut path = [0; TREE_DEPTH];
    let mut z = 0;
    for i in 1..TREE_DEPTH {
        z = h([T_NODE, z, z]);
        path[i] = z;
    }
    let cm = claim.commit(DEPLOYMENT);
    let nf = rec_nullifier(cm, claim.rec_nonce);
    let expiry = NOW + 3600;
    let next = LpClaim {
        pool: claim.pool,
        shares: claim.shares,
        owner_auth: claim.owner_auth,
        owner_x: claim.owner_x,
        owner_y: claim.owner_y,
        expiry,
        price_lo,
        price_hi,
        rec_nonce: rec_nonce(nf, 0, 0, 23),
        blind: 24,
    };
    let k = [owner, key(31), key(32), key(33)];
    let eph = [25, 26, 27, 28];
    let mut ct: [[Field; LP_CT_LEN]; 4] = [[0; LP_CT_LEN]; 4];
    for i in 0..4 {
        ct[i] = encrypt(next.plaintext(), k[i], eph[i]);
    }
    main(
        claim,
        0,
        path,
        SK,
        price_lo,
        price_hi,
        expiry,
        23,
        24,
        eph,
        merkle_root(cm, 0, path),
        nf,
        next.commit(DEPLOYMENT),
        ct,
        DEPLOYMENT,
        NOW,
        0,
        [[k[1].x, k[1].y], [k[2].x, k[2].y], [k[3].x, k[3].y]],
    );
}

#[test]
fn request_commits_a_band() {
    request(3 * WAD, 5 * WAD);
}

#[test]
fn request_accepts_a_point_band_and_a_128_bit_bound() {
    request(4 * WAD, 4 * WAD);
    request(WAD, MAX_BAND);
}

#[test(should_fail)]
fn request_rejects_a_129_bit_bound() {
    request(WAD, MAX_BAND + 1);
}

#[test(should_fail_with = "inverted band")]
fn request_rejects_an_inverted_band() {
    request(5 * WAD, 3 * WAD);
}

#[test]
fn request_accepts_open_ended_bands() {
    request(0, 5 * WAD);
    request(3 * WAD, MAX_BAND);
    request(0, MAX_BAND);
}

#[test(should_fail_with = "empty band")]
fn request_rejects_a_zero_upper_bound() {
    request(0, 0);
}

#[test(should_fail_with = "inverted band")]
fn request_rejects_an_open_lower_bound_above_a_closed_upper_one() {
    request(MAX_BAND, 5 * WAD);
}
