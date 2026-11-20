// Whole-circuit executions of the delta kinds (an open of 4 then a change on the long side of a fresh market) and of the
// public bond draw.
use crate::{BATCH, Delta, KEYS, main};
use rooq_zk::{encrypt, floor_div, market_head, MARKET_CT_LEN, min, OI_CLOSE, OI_OPEN, OI_REDUCE, oi_delta, WAD};
use std::embedded_curve_ops::{EmbeddedCurveScalar, fixed_base_scalar_mul};

global DEPLOYMENT: Field = 31337;
global MARKET: Field = 1;

fn fold(second_kind: Field, second_size: Field) {
    fold_claim(second_kind, second_size, 0, 0, 0, 0, 0);
}

/// The second change carries a penalty share `ins_in` and a claim; `bond_total` backs what insurance can't pay.
fn fold_claim(
    second_kind: Field,
    second_size: Field,
    ins_in: Field,
    claim: Field,
    bond_total: Field,
    bond_used_prev: Field,
    bond_used_next: Field,
) {
    let mut deltas = [Delta { is_short: 0, size: 0, kind: 0, ins_in: 0, claim: 0, rec_nonce: 0 }; BATCH];
    deltas[0] = Delta { is_short: 0, size: 4 * WAD, kind: OI_OPEN, ins_in: 0, claim: 0, rec_nonce: 7 };
    deltas[1] = Delta { is_short: 0, size: second_size, kind: second_kind, ins_in, claim, rec_nonce: 8 };
    let mut delta_cm = [0; BATCH];
    for i in 0..2 {
        let d = deltas[i];
        delta_cm[i] = oi_delta(DEPLOYMENT, MARKET, d.is_short, d.size, d.kind, d.ins_in, d.claim, d.rec_nonce);
    }
    let long_next = 4 * WAD - second_size;
    let paid = min(ins_in + bond_total, claim);
    let ratio = if claim == 0 { WAD } else { floor_div(paid * WAD, claim) };
    let insurance_next = ins_in - min(paid, ins_in);
    let bad_debt_next = claim - paid;
    let mut keys = [[0; 2]; KEYS];
    let mut ct = [[0; MARKET_CT_LEN]; KEYS];
    let eph = [31, 32, 33];
    for i in 0..KEYS {
        let pk = fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(101 + i as Field));
        keys[i] = [pk.x, pk.y];
        ct[i] = encrypt([long_next, 0, insurance_next, bad_debt_next, bond_used_next, 9], pk, eph[i]);
    }
    main(
        0,
        0,
        0,
        0,
        0,
        0,
        9,
        deltas,
        eph,
        DEPLOYMENT,
        MARKET,
        0,
        market_head(DEPLOYMENT, MARKET, long_next, 0, insurance_next, bad_debt_next, bond_used_next, 9),
        2,
        delta_cm,
        30,
        250 * WAD,
        WAD / 100,
        0,
        0,
        ratio,
        bond_total,
        keys,
        ct,
        bond_used_prev,
        bond_used_next,
    );
}

#[test]
fn folds_a_reduce_delta_of_kind_2() {
    fold(OI_REDUCE, WAD);
}

#[test]
fn folds_a_close_delta_of_kind_1() {
    fold(OI_CLOSE, 4 * WAD);
}

#[test(should_fail_with = "unknown kind")]
fn rejects_kind_3() {
    fold(3, WAD);
}

#[test(should_fail_with = "open interest underflow")]
fn reduce_cannot_remove_more_than_is_open() {
    fold(OI_REDUCE, 4 * WAD + 1);
}

#[test]
fn bond_used_next_is_the_bond_drawn() {
    // A close with a 3-unit penalty share and a 10-unit claim: insurance pays 3, the bond the other 7.
    fold_claim(OI_CLOSE, 4 * WAD, 3, 10, 100, 0, 7);
}

#[test]
fn bond_used_stays_put_when_insurance_covers_the_claims() {
    fold_claim(OI_CLOSE, 4 * WAD, 10, 10, 100, 0, 0);
}

#[test]
fn bond_draw_stops_at_the_bond() {
    // 3 from insurance and all 5 of the bond; the other 2 become bad debt.
    fold_claim(OI_CLOSE, 4 * WAD, 3, 10, 5, 0, 5);
}

#[test(should_fail_with = "wrong bond_used_next")]
fn bond_used_next_cannot_understate_the_draw() {
    fold_claim(OI_CLOSE, 4 * WAD, 3, 10, 100, 0, 6);
}

#[test(should_fail_with = "wrong bond_used_prev")]
fn bond_used_prev_must_match_the_head() {
    fold_claim(OI_CLOSE, 4 * WAD, 3, 10, 100, 1, 8);
}
