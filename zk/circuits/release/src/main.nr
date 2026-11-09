// Refunds an expired LOCK to its owner as a FREE note. Needs no owner key: whoever holds the lock plaintext (the
// owner or the coordinator) can prove it, and the only possible beneficiary is the owner committed in the lock.
// `now` is checked by the contract to be no later than the block timestamp.
use rooq_zk::{
    encrypt, FREE_DOMAIN, Lock, merkle_root, note_commitment, note_inner, NOTE_CT_LEN, output_rho, point,
    rec_nullifier, TREE_DEPTH,
};

fn main(
    lock: Lock,
    index: Field,
    path: [Field; TREE_DEPTH],
    blind: Field,
    eph: Field,
    root: pub Field,
    nf: pub Field,
    cm_out: pub Field,
    ct: pub [Field; NOTE_CT_LEN],
    deployment: pub Field,
    now: pub Field,
) {
    let cm = lock.commit(deployment);
    assert_eq(merkle_root(cm, index, path), root, "lock not in tree");
    assert_eq(rec_nullifier(cm, lock.rec_nonce), nf);
    lock.expiry.assert_max_bit_size::<64>();
    now.assert_max_bit_size::<64>();
    assert(lock.expiry.lt(now), "lock not expired");

    let rho = output_rho(nf, 0, 0);
    assert_eq(cm_out, note_commitment(deployment, FREE_DOMAIN, lock.asset, lock.amount, note_inner(lock.owner(), rho, blind)));
    assert_eq(encrypt([FREE_DOMAIN, lock.asset, lock.amount, rho, blind], point(lock.owner_x, lock.owner_y), eph), ct);
}
