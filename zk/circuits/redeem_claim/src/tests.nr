// Whole-circuit executions of the relay fee on a claim of 10 units paid at a ratio of one half. Fee rules: zero to the
// owner's own address needs no key, anything else needs the claim owner's.
use crate::main;
use rooq_zk::{
    auth_key, Claim, encrypt, FREE_DOMAIN, h, merkle_root, note_commitment, note_inner, NOTE_CT_LEN, output_rho, owner_tag,
    rec_nullifier, RelayFee, T_NODE, TREE_DEPTH, WAD,
};
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul};

global DEPLOYMENT: Field = 31337;
global ASSET: Field = 0xa0;
global OWNER_SK: Field = 12;
global PAID: Field = 5;

fn key(sk: Field) -> EmbeddedCurvePoint {
    fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(sk))
}

fn zero_fee_to_owner() -> RelayFee {
    RelayFee { value: 0, auth: auth_key(OWNER_SK), pk: key(OWNER_SK), blind: 25, eph: 26 }
}

fn fee_to_relayer(value: Field) -> RelayFee {
    RelayFee { value, auth: 27, pk: key(28), blind: 25, eph: 26 }
}

fn redeem(sk: Field, relay: RelayFee, payout: Field) {
    let owner_pk = key(OWNER_SK);
    let claim = Claim {
        market: 1,
        asset: ASSET,
        amount: 2 * PAID,
        owner_auth: auth_key(OWNER_SK),
        owner_x: owner_pk.x,
        owner_y: owner_pk.y,
        ins_in: 0,
        pair_nonce: 7,
        delta_cm: 8,
        rec_nonce: 17,
        blind: 18,
    };
    let cm = claim.commit(DEPLOYMENT);
    let mut path = [0; TREE_DEPTH];
    let mut z = 0;
    for i in 1..TREE_DEPTH {
        z = h([T_NODE, z, z]);
        path[i] = z;
    }
    let nf = rec_nullifier(cm, claim.rec_nonce);
    let rho = output_rho(nf, 0, 0);
    let ct: [Field; NOTE_CT_LEN] = encrypt([FREE_DOMAIN, ASSET, payout, rho, 23], owner_pk, 24);
    let (cm_relay, ct_relay) = relay.note(DEPLOYMENT, ASSET, nf, 0, 1);
    main(
        claim,
        0,
        path,
        23,
        24,
        sk,
        relay,
        merkle_root(cm, 0, path),
        nf,
        note_commitment(DEPLOYMENT, FREE_DOMAIN, ASSET, payout, note_inner(owner_tag(claim.owner_auth, owner_pk), rho, 23)),
        ct,
        DEPLOYMENT,
        8,
        WAD / 2,
        cm_relay,
        ct_relay,
    );
}

#[test]
fn keyless_redeem_with_a_zero_fee_to_the_owner() {
    redeem(0, zero_fee_to_owner(), PAID);
}

#[test]
fn owner_pays_the_fee_from_the_payout() {
    redeem(OWNER_SK, fee_to_relayer(2), PAID - 2);
}

#[test(should_fail_with = "fee needs the owner key")]
fn keyless_redeem_cannot_pay_a_fee() {
    redeem(0, fee_to_relayer(2), PAID - 2);
}

#[test(should_fail)]
fn fee_must_come_out_of_the_payout() {
    redeem(OWNER_SK, fee_to_relayer(2), PAID);
}

#[test(should_fail_with = "fee above available")]
fn fee_above_the_ratio_scaled_payout() {
    redeem(OWNER_SK, fee_to_relayer(PAID + 1), 0);
}
