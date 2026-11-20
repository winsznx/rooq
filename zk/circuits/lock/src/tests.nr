// Whole-circuit executions of the lock lifetime caps (7 days for intents, 30 days for maker backing), the per-role t3 range
// and the relay fee.
use crate::{Change, InputNote, LockOut, main};
use rooq_zk::{
    auth_key, encrypt, FREE_DOMAIN, h, Lock, LOCK_CT_LEN, merkle_root, note_commitment, note_inner, NOTE_CT_LEN, nullifier_key, output_rho,
    owner_nullifier, owner_tag, point, rec_nonce, RelayFee, ROLE_LP, ROLE_MAKER, ROLE_SWAP, ROLE_TAKER, T_NODE, TREE_DEPTH,
    WAD,
};
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul};

global DEPLOYMENT: Field = 31337;
global ASSET: Field = 0xa0;
global AS_OF: Field = 1_000_000;
global DAY: Field = 86_400;
global INTENT_LIFETIME: Field = 7 * DAY;
global MAKER_LIFETIME: Field = 30 * DAY;
global SK: Field = 11;

fn key(sk: Field) -> EmbeddedCurvePoint {
    fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(sk))
}

fn lock_until(role: Field, t2: Field, expiry: Field) {
    lock_with(role, t2, WAD, expiry);
}

fn lock_with(role: Field, t2: Field, t3: Field, expiry: Field) {
    lock_paying(role, t2, t3, expiry, 2, zero_fee_to_self());
}

fn zero_fee_to_self() -> RelayFee {
    RelayFee { value: 0, auth: auth_key(SK), pk: key(SK), blind: 25, eph: 26 }
}

fn fee_to_relayer(value: Field) -> RelayFee {
    RelayFee { value, auth: 27, pk: key(28), blind: 25, eph: 26 }
}

/// Locks 3 of a 5-unit note, alone in the tree at leaf 0. The second input is empty.
fn lock_paying(role: Field, t2: Field, t3: Field, expiry: Field, change_value: Field, relay: RelayFee) {
    let pk = key(SK);
    let auth = auth_key(SK);
    let owner = owner_tag(auth, pk);
    let nk = nullifier_key(SK);
    let input_cm = note_commitment(DEPLOYMENT, FREE_DOMAIN, ASSET, 5, note_inner(owner, 1, 2));
    let mut path = [0; TREE_DEPTH];
    let mut z = 0;
    for i in 1..TREE_DEPTH {
        z = h([T_NODE, z, z]);
        path[i] = z;
    }
    let nf = [
        owner_nullifier(nk, input_cm),
        owner_nullifier(nk, note_commitment(DEPLOYMENT, FREE_DOMAIN, ASSET, 0, note_inner(owner, 3, 4))),
    ];
    let rho = output_rho(nf[0], nf[1], 0);
    let payout = key(12);
    let coordinator = key(13);
    let risk = [key(14), key(15)];
    let out = LockOut {
        payout_auth: 16,
        payout_pk: payout,
        view_pk: pk,
        amount: 3,
        role,
        market: 1,
        t2,
        t3,
        t4: 1,
        expiry,
        salt: 17,
        blind: 18,
        eph_owner: 19,
        eph_coordinator: 20,
        eph_risk: [21, 22],
    };
    let record = Lock {
        asset: ASSET,
        amount: out.amount,
        owner_auth: out.payout_auth,
        owner_x: payout.x,
        owner_y: payout.y,
        role,
        market: out.market,
        t2,
        t3: out.t3,
        t4: out.t4,
        expiry,
        rec_nonce: rec_nonce(nf[0], nf[1], 1, out.salt),
        blind: out.blind,
    };
    let pt = record.plaintext();
    let ct_risk: [[Field; LOCK_CT_LEN]; 2] = [encrypt(pt, risk[0], 21), encrypt(pt, risk[1], 22)];
    let ct_change: [Field; NOTE_CT_LEN] = encrypt([FREE_DOMAIN, ASSET, change_value, rho, 23], pk, 24);
    let (cm_relay, ct_relay) = relay.note(DEPLOYMENT, ASSET, nf[0], nf[1], 2);
    main(
        SK,
        pk,
        ASSET,
        [
            InputNote { value: 5, rho: 1, blind: 2, index: 0, path },
            InputNote { value: 0, rho: 3, blind: 4, index: 0, path: [0; TREE_DEPTH] },
        ],
        Change { value: change_value, blind: 23, eph: 24 },
        out,
        relay,
        merkle_root(input_cm, 0, path),
        nf,
        note_commitment(DEPLOYMENT, FREE_DOMAIN, ASSET, change_value, note_inner(owner, rho, 23)),
        record.commit(DEPLOYMENT),
        ct_change,
        encrypt(pt, pk, 19),
        encrypt(pt, point(coordinator.x, coordinator.y), 20),
        DEPLOYMENT,
        [coordinator.x, coordinator.y],
        ct_risk,
        [[risk[0].x, risk[0].y], [risk[1].x, risk[1].y]],
        AS_OF,
        [INTENT_LIFETIME, MAKER_LIFETIME],
        cm_relay,
        ct_relay,
    );
}

#[test]
fn taker_lock_at_seven_days() {
    lock_until(ROLE_TAKER, 0, AS_OF + INTENT_LIFETIME);
}

#[test(should_fail_with = "lock outlives the maximum")]
fn taker_lock_past_seven_days() {
    lock_until(ROLE_TAKER, 0, AS_OF + INTENT_LIFETIME + 1);
}

#[test(should_fail_with = "lock outlives the maximum")]
fn swap_lock_past_seven_days() {
    lock_until(ROLE_SWAP, 0, AS_OF + INTENT_LIFETIME + 1);
}

#[test(should_fail_with = "lock outlives the maximum")]
fn lp_lock_past_seven_days() {
    lock_until(ROLE_LP, 0, AS_OF + INTENT_LIFETIME + 1);
}

#[test]
fn maker_lock_at_thirty_days() {
    lock_until(ROLE_MAKER, 10, AS_OF + MAKER_LIFETIME);
}

#[test(should_fail_with = "lock outlives the maximum")]
fn maker_lock_past_thirty_days() {
    lock_until(ROLE_MAKER, 10, AS_OF + MAKER_LIFETIME + 1);
}

#[test]
fn lp_lock_accepts_a_128_bit_price_bound() {
    lock_with(ROLE_LP, 1, 0xffffffffffffffffffffffffffffffff, AS_OF + DAY);
}

#[test]
fn lp_lock_side_0_accepts_an_open_lower_bound() {
    lock_with(ROLE_LP, 0, 0, AS_OF + DAY);
}

#[test(should_fail_with = "empty band")]
fn lp_lock_side_1_rejects_a_zero_upper_bound() {
    lock_with(ROLE_LP, 1, 0, AS_OF + DAY);
}

#[test(should_fail_with = "zero size")]
fn swap_lock_still_rejects_a_zero_minimum() {
    lock_with(ROLE_SWAP, 0, 0, AS_OF + DAY);
}

#[test(should_fail)]
fn lp_lock_rejects_a_129_bit_price_bound() {
    lock_with(ROLE_LP, 1, 0x100000000000000000000000000000000, AS_OF + DAY);
}

#[test]
fn swap_lock_accepts_a_96_bit_minimum() {
    lock_with(ROLE_SWAP, 0, 0xffffffffffffffffffffffff, AS_OF + DAY);
}

#[test(should_fail)]
fn swap_lock_still_caps_t3_at_size_bits() {
    lock_with(ROLE_SWAP, 0, 0x1000000000000000000000000, AS_OF + DAY);
}

#[test]
fn zero_relay_fee_to_self() {
    lock_paying(ROLE_TAKER, 0, WAD, AS_OF + DAY, 2, zero_fee_to_self());
}

#[test]
fn relay_fee_comes_out_of_the_inputs() {
    lock_paying(ROLE_TAKER, 0, WAD, AS_OF + DAY, 1, fee_to_relayer(1));
    lock_paying(ROLE_TAKER, 0, WAD, AS_OF + DAY, 0, fee_to_relayer(2));
}

#[test(should_fail_with = "value not conserved")]
fn relay_fee_must_be_deducted() {
    lock_paying(ROLE_TAKER, 0, WAD, AS_OF + DAY, 2, fee_to_relayer(1));
}

#[test(should_fail)]
fn relay_fee_above_the_inputs() {
    lock_paying(ROLE_TAKER, 0, WAD, AS_OF + DAY, 0 - 1, fee_to_relayer(3));
}
