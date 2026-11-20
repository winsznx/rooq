// Whole-circuit executions of the relay fee. A long of 4 units at 250 closed flat at its entry with no funding moving and
// no market fee, so the taker gets its 100 USDG margin back less the relay fee and the maker gets its 200 back.
use crate::main;
use rooq_zk::{
    auth_key, encrypt, FREE_DOMAIN, h, merkle_root, note_commitment, note_inner, NOTE_CT_LEN, OI_CLOSE, oi_delta, output_rho,
    owner_tag, Pair, rec_nullifier, RelayFee, T_NODE, TREE_DEPTH, WAD,
};
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul};

global DEPLOYMENT: Field = 31337;
global MARKET: Field = 1;
global ASSET: Field = 0xa0;
global ENTRY: Field = 250 * WAD;
global FUNDING_ZERO: Field = 0x100000000000000000000000000000000;
global USDG: Field = 1_000_000;
global TAKER_SK: Field = 11;
global MAKER_SK: Field = 22;
global TAKER_MARGIN: Field = 100 * USDG;
global MAKER_MARGIN: Field = 200 * USDG;

fn key(sk: Field) -> EmbeddedCurvePoint {
    fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(sk))
}

fn zero_fee_to_taker() -> RelayFee {
    RelayFee { value: 0, auth: auth_key(TAKER_SK), pk: key(TAKER_SK), blind: 25, eph: 26 }
}

fn fee_to_relayer(value: Field) -> RelayFee {
    RelayFee { value, auth: 27, pk: key(28), blind: 25, eph: 26 }
}

fn close(mode: Field, sk: Field, relay: RelayFee, taker_out: Field) {
    let t = key(TAKER_SK);
    let m = key(MAKER_SK);
    let pair = Pair {
        market: MARKET,
        asset: ASSET,
        is_short: 0,
        size: 4 * WAD,
        entry: ENTRY,
        funding_index: FUNDING_ZERO,
        close_spread: 0,
        funding_debt: 0,
        debt_by_taker: 0,
        last_reduce: 0,
        updated_at: 0,
        taker_margin: TAKER_MARGIN,
        maker_margin: MAKER_MARGIN,
        taker_auth: auth_key(TAKER_SK),
        taker_x: t.x,
        taker_y: t.y,
        maker_auth: auth_key(MAKER_SK),
        maker_x: m.x,
        maker_y: m.y,
        rec_nonce: 5,
        blind: 6,
    };
    let cm = pair.commit(DEPLOYMENT);
    let mut path = [0; TREE_DEPTH];
    let mut z = 0;
    for i in 1..TREE_DEPTH {
        z = h([T_NODE, z, z]);
        path[i] = z;
    }
    let nf = rec_nullifier(cm, pair.rec_nonce);
    let fee_pk = key(103);
    let outs = [(taker_out, pair.taker_auth, t), (MAKER_MARGIN, pair.maker_auth, m), (0, 104, fee_pk)];
    let blind = [41, 42, 43];
    let eph = [51, 52, 53];
    let mut cm_out = [0; 3];
    let mut ct = [[0; NOTE_CT_LEN]; 3];
    for i in 0..3 {
        let (value, auth, pk) = outs[i];
        let rho = output_rho(nf, 0, i as Field);
        cm_out[i] = note_commitment(DEPLOYMENT, FREE_DOMAIN, ASSET, value, note_inner(owner_tag(auth, pk), rho, blind[i]));
        ct[i] = encrypt([FREE_DOMAIN, ASSET, value, rho, blind[i]], pk, eph[i]);
    }
    let (cm_relay, ct_relay) = relay.note(DEPLOYMENT, ASSET, nf, 0, 3);
    main(
        pair,
        0,
        path,
        sk,
        blind,
        eph,
        relay,
        merkle_root(cm, 0, path),
        nf,
        cm_out,
        ct,
        DEPLOYMENT,
        MARKET,
        ASSET,
        if mode == 2 { 0 } else { ENTRY },
        1_000_000_000_000,
        FUNDING_ZERO,
        oi_delta(DEPLOYMENT, MARKET, 0, 4 * WAD, OI_CLOSE, 0, 0, pair.rec_nonce),
        mode,
        0,
        104,
        [fee_pk.x, fee_pk.y],
        cm_relay,
        ct_relay,
    );
}

#[test]
fn taker_close_with_a_zero_fee_to_self() {
    close(0, TAKER_SK, zero_fee_to_taker(), TAKER_MARGIN);
}

#[test]
fn keyless_closes_with_a_zero_fee() {
    close(1, 0, zero_fee_to_taker(), TAKER_MARGIN);
    close(2, 0, zero_fee_to_taker(), TAKER_MARGIN);
}

#[test]
fn taker_pays_the_fee_from_its_payout() {
    close(0, TAKER_SK, fee_to_relayer(3 * USDG), TAKER_MARGIN - 3 * USDG);
    close(1, TAKER_SK, fee_to_relayer(TAKER_MARGIN), 0);
}

#[test(should_fail_with = "fee needs the owner key")]
fn keyless_forced_exit_cannot_pay_a_fee() {
    close(1, 0, fee_to_relayer(3 * USDG), TAKER_MARGIN - 3 * USDG);
}

#[test(should_fail_with = "fee needs the owner key")]
fn keyless_dead_oracle_close_cannot_pay_a_fee() {
    close(2, 0, fee_to_relayer(3 * USDG), TAKER_MARGIN - 3 * USDG);
}

#[test(should_fail_with = "fee needs the owner key")]
fn maker_key_cannot_pay_a_fee_from_the_pair() {
    close(1, MAKER_SK, fee_to_relayer(3 * USDG), TAKER_MARGIN - 3 * USDG);
}

#[test(should_fail)]
fn fee_must_come_out_of_the_taker_payout() {
    close(0, TAKER_SK, fee_to_relayer(3 * USDG), TAKER_MARGIN);
}

#[test(should_fail_with = "fee above available")]
fn fee_above_the_taker_payout() {
    close(0, TAKER_SK, fee_to_relayer(TAKER_MARGIN + 1), 0);
}
