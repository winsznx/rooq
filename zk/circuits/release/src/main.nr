// Refunds an expired LOCK to its owner as a FREE note. Needs no owner key: whoever holds the lock plaintext (the
// owner or the coordinator) can prove it, and the only possible beneficiary is the owner committed in the lock.
// `now` is checked by the contract to be no later than the block timestamp.
//
// The relay fee note (rho index 1) comes out of the refund. A nonzero fee needs the lock owner's key, so a prover holding
// only the plaintext can't route the refund to itself; it can still release with a zero fee.
use rooq_zk::{
    auth_key, encrypt, FREE_DOMAIN, Lock, merkle_root, note_commitment, note_inner, NOTE_CT_LEN, output_rho, point,
    rec_nullifier, relay_fee_note, RelayFee, TREE_DEPTH,
};

mod tests;

fn main(
    lock: Lock,
    index: Field,
    path: [Field; TREE_DEPTH],
    blind: Field,
    eph: Field,
    sk: Field,
    relay: RelayFee,
    root: pub Field,
    nf: pub Field,
    cm_out: pub Field,
    ct: pub [Field; NOTE_CT_LEN],
    deployment: pub Field,
    now: pub Field,
    cm_relay: pub Field,
    ct_relay: pub [Field; NOTE_CT_LEN],
) {
    let cm = lock.commit(deployment);
    assert_eq(merkle_root(cm, index, path), root, "lock not in tree");
    assert_eq(rec_nullifier(cm, lock.rec_nonce), nf);
    lock.expiry.assert_max_bit_size::<64>();
    now.assert_max_bit_size::<64>();
    assert(lock.expiry.lt(now), "lock not expired");

    relay_fee_note(deployment, lock.asset, relay, nf, 0, 1, cm_relay, ct_relay);
    if relay.value != 0 {
        assert_eq(auth_key(sk), lock.owner_auth, "fee needs the owner key");
    }
    assert(!lock.amount.lt(relay.value), "fee above available");
    let value = lock.amount - relay.value;

    let rho = output_rho(nf, 0, 0);
    assert_eq(cm_out, note_commitment(deployment, FREE_DOMAIN, lock.asset, value, note_inner(lock.owner(), rho, blind)));
    assert_eq(encrypt([FREE_DOMAIN, lock.asset, value, rho, blind], point(lock.owner_x, lock.owner_y), eph), ct);
}
