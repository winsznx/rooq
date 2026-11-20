// Whole-circuit executions of the relay fee on a refund of 5 units. Fee rules: zero to the owner's own address needs no key,
// anything else needs the lock owner's.
use crate::main;
use rooq_zk::{
    auth_key, encrypt, FREE_DOMAIN, h, Lock, merkle_root, note_commitment, note_inner, NOTE_CT_LEN, output_rho,
    rec_nullifier, RelayFee, ROLE_TAKER, T_NODE, TREE_DEPTH,
};
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul};

global DEPLOYMENT: Field = 31337;
global ASSET: Field = 0xa0;
global OWNER_SK: Field = 12;
global AMOUNT: Field = 5;
global NOW: Field = 2_000_000;

fn key(sk: Field) -> EmbeddedCurvePoint {
    fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(sk))
}

fn zero_fee_to_owner() -> RelayFee {
    RelayFee { value: 0, auth: auth_key(OWNER_SK), pk: key(OWNER_SK), blind: 25, eph: 26 }
}

fn fee_to_relayer(value: Field) -> RelayFee {
    RelayFee { value, auth: 27, pk: key(28), blind: 25, eph: 26 }
}

/// Releases an expired 5-unit lock, alone in the tree at leaf 0, refunding `refund`.
fn release(sk: Field, relay: RelayFee, refund: Field) {
    let owner_pk = key(OWNER_SK);
    let lock = Lock {
        asset: ASSET,
        amount: AMOUNT,
        owner_auth: auth_key(OWNER_SK),
        owner_x: owner_pk.x,
        owner_y: owner_pk.y,
        role: ROLE_TAKER,
        market: 1,
        t2: 0,
        t3: 1,
        t4: 1,
        expiry: NOW - 1,
        rec_nonce: 17,
        blind: 18,
    };
    let cm = lock.commit(DEPLOYMENT);
    let mut path = [0; TREE_DEPTH];
    let mut z = 0;
    for i in 1..TREE_DEPTH {
        z = h([T_NODE, z, z]);
        path[i] = z;
    }
    let nf = rec_nullifier(cm, lock.rec_nonce);
    let rho = output_rho(nf, 0, 0);
    let ct: [Field; NOTE_CT_LEN] = encrypt([FREE_DOMAIN, ASSET, refund, rho, 23], owner_pk, 24);
    let (cm_relay, ct_relay) = relay.note(DEPLOYMENT, ASSET, nf, 0, 1);
    main(
        lock,
        0,
        path,
        23,
        24,
        sk,
        relay,
        merkle_root(cm, 0, path),
        nf,
        note_commitment(DEPLOYMENT, FREE_DOMAIN, ASSET, refund, note_inner(lock.owner(), rho, 23)),
        ct,
        DEPLOYMENT,
        NOW,
        cm_relay,
        ct_relay,
    );
}

#[test]
fn keyless_release_with_a_zero_fee_to_the_owner() {
    release(0, zero_fee_to_owner(), AMOUNT);
}

#[test]
fn owner_pays_the_fee_from_the_refund() {
    release(OWNER_SK, fee_to_relayer(2), AMOUNT - 2);
    release(OWNER_SK, fee_to_relayer(AMOUNT), 0);
}

#[test(should_fail_with = "fee needs the owner key")]
fn keyless_release_cannot_pay_a_fee() {
    release(0, fee_to_relayer(2), AMOUNT - 2);
}

#[test(should_fail_with = "fee needs the owner key")]
fn keyless_release_cannot_take_the_whole_refund() {
    release(99, fee_to_relayer(AMOUNT), 0);
}

#[test(should_fail)]
fn fee_must_come_out_of_the_refund() {
    release(OWNER_SK, fee_to_relayer(2), AMOUNT);
}

#[test(should_fail_with = "fee above available")]
fn fee_above_the_lock_amount() {
    release(OWNER_SK, fee_to_relayer(AMOUNT + 1), 0);
}
