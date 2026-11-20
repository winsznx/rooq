// Whole-circuit executions of the protocol fee sweep.
use crate::main;
use rooq_zk::{
    encrypt, FREE_DOMAIN, note_commitment, note_inner, NOTE_CT_LEN, output_rho, owner_tag, POOL_CT_LEN, pool_head, pool_plaintext,
    PoolState,
};
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul};

global DEPLOYMENT: Field = 31337;
global POOL: Field = 1;
global TOKEN0: Field = 0xa0;
global TOKEN1: Field = 0xa1;
global FEE_AUTH: Field = 91;

fn key(sk: Field) -> EmbeddedCurvePoint {
    fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(sk))
}

/// Sweeps a pool with the given accruals, expecting the fee address to receive `paid` and the accruals to be zero after.
fn sweep(proto0: Field, proto1: Field, paid: [Field; 2]) {
    let state = PoolState { r0: 1_000_000, r1: 4_000_000, supply: 2_000_000, last_leaf: 5, proto0, proto1, blind: 41 };
    let next = PoolState { r0: 1_000_000, r1: 4_000_000, supply: 2_000_000, last_leaf: 5, proto0: 0, proto1: 0, blind: 42 };
    let (head, new_head) = (pool_head(DEPLOYMENT, POOL, state), pool_head(DEPLOYMENT, POOL, next));
    let k = [key(31), key(32), key(33)];
    let keys = [[k[0].x, k[0].y], [k[1].x, k[1].y], [k[2].x, k[2].y]];
    let pool_eph = [61, 62, 63];
    let mut ct_pool: [[Field; POOL_CT_LEN]; 3] = [[0; POOL_CT_LEN]; 3];
    for i in 0..3 {
        ct_pool[i] = encrypt(pool_plaintext(next), k[i], pool_eph[i]);
    }
    let fee_key = key(90);
    let tokens = [TOKEN0, TOKEN1];
    let out_blind = [81, 82];
    let out_eph = [83, 84];
    let mut cm_out = [0; 2];
    let mut ct_out: [[Field; NOTE_CT_LEN]; 2] = [[0; NOTE_CT_LEN]; 2];
    for i in 0..2 {
        let rho = output_rho(head, new_head, i as Field);
        cm_out[i] = note_commitment(
            DEPLOYMENT,
            FREE_DOMAIN,
            tokens[i],
            paid[i],
            note_inner(owner_tag(FEE_AUTH, fee_key), rho, out_blind[i]),
        );
        ct_out[i] = encrypt([FREE_DOMAIN, tokens[i], paid[i], rho, out_blind[i]], fee_key, out_eph[i]);
    }
    main(
        state,
        42,
        out_blind,
        out_eph,
        pool_eph,
        head,
        new_head,
        cm_out,
        ct_out,
        ct_pool,
        DEPLOYMENT,
        POOL,
        TOKEN0,
        TOKEN1,
        FEE_AUTH,
        [fee_key.x, fee_key.y],
        keys,
    );
}

#[test]
fn sweep_pays_both_accruals_and_zeroes_them() {
    sweep(7, 30, [7, 30]);
}

#[test]
fn sweep_pays_a_single_accrual() {
    sweep(0, 30, [0, 30]);
}

#[test(should_fail)]
fn sweep_cannot_underpay() {
    sweep(7, 30, [6, 30]);
}

#[test(should_fail_with = "nothing to sweep")]
fn sweep_refuses_an_empty_accrual() {
    sweep(0, 0, [0, 0]);
}
