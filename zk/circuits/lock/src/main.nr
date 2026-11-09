// Owner-proved escrow: consumes up to two FREE notes into a FREE change note and one LOCK record carrying
// committed trade terms (taker order or maker backing). The coordinator can consume the lock only as the terms
// allow (open_pair); after expiry anyone holding its plaintext can refund it to the owner (release). Proved in the
// wallet, so the spending key never leaves it.
//
// The lock pays out to a one-time address (D-06), so the coordinator and risk workers cannot link a wallet's
// positions. The record is encrypted to the wallet's main key, to the coordinator key and to both risk keys fixed by the
// contract, so a risk worker can execute or refund it if the coordinator is gone (REC-06).
// The asset stays private.
use rooq_zk::{
    assert_amount, assert_on_curve, auth_key, encrypt, FREE_DOMAIN, Lock, LOCK_CT_LEN, merkle_root, note_commitment, note_inner,
    NOTE_CT_LEN, nullifier_key, output_rho, owner_nullifier, owner_tag, point, rec_nonce, TREE_DEPTH,
};
use std::embedded_curve_ops::EmbeddedCurvePoint;

struct InputNote {
    value: Field,
    rho: Field,
    blind: Field,
    index: Field,
    path: [Field; TREE_DEPTH],
}

struct Change {
    value: Field,
    blind: Field,
    eph: Field,
}

struct LockOut {
    payout_auth: Field,
    payout_pk: EmbeddedCurvePoint,
    view_pk: EmbeddedCurvePoint,
    amount: Field,
    role: Field,
    market: Field,
    t2: Field,
    t3: Field,
    t4: Field,
    expiry: Field,
    salt: Field,
    blind: Field,
    eph_owner: Field,
    eph_coordinator: Field,
    eph_risk: [Field; 2],
}

fn main(
    sk: Field,
    own_pk: EmbeddedCurvePoint,
    asset: Field,
    ins: [InputNote; 2],
    change: Change,
    lock: LockOut,
    root: pub Field,
    nf: pub [Field; 2],
    cm_change: pub Field,
    cm_lock: pub Field,
    ct_change: pub [Field; NOTE_CT_LEN],
    ct_owner: pub [Field; LOCK_CT_LEN],
    ct_coordinator: pub [Field; LOCK_CT_LEN],
    deployment: pub Field,
    coordinator_pk: pub [Field; 2],
    ct_risk: pub [[Field; LOCK_CT_LEN]; 2],
    risk_pk: pub [[Field; 2]; 2],
) {
    let auth = auth_key(sk);
    let owner = owner_tag(auth, own_pk);
    let nk = nullifier_key(sk);

    let mut total_in = 0;
    for i in 0..2 {
        let n = ins[i];
        assert_amount(n.value);
        let cm = note_commitment(deployment, FREE_DOMAIN, asset, n.value, note_inner(owner, n.rho, n.blind));
        if n.value != 0 {
            assert_eq(merkle_root(cm, n.index, n.path), root, "input not in tree");
        }
        assert_eq(owner_nullifier(nk, cm), nf[i]);
        total_in += n.value;
    }
    assert(nf[0] != nf[1], "same note twice");

    assert_amount(change.value);
    let rho = output_rho(nf[0], nf[1], 0);
    assert_eq(cm_change, note_commitment(deployment, FREE_DOMAIN, asset, change.value, note_inner(owner, rho, change.blind)));
    assert_eq(encrypt([FREE_DOMAIN, asset, change.value, rho, change.blind], own_pk, change.eph), ct_change);

    let record = Lock {
        asset,
        amount: lock.amount,
        owner_auth: lock.payout_auth,
        owner_x: lock.payout_pk.x,
        owner_y: lock.payout_pk.y,
        role: lock.role,
        market: lock.market,
        t2: lock.t2,
        t3: lock.t3,
        t4: lock.t4,
        expiry: lock.expiry,
        rec_nonce: rec_nonce(nf[0], nf[1], 1, lock.salt),
        blind: lock.blind,
    };
    record.assert_well_formed();
    assert_on_curve(lock.payout_pk);
    assert_eq(record.commit(deployment), cm_lock);
    assert_eq(encrypt(record.plaintext(), lock.view_pk, lock.eph_owner), ct_owner);
    assert_eq(
        encrypt(record.plaintext(), point(coordinator_pk[0], coordinator_pk[1]), lock.eph_coordinator),
        ct_coordinator,
    );
    for i in 0..2 {
        assert_eq(encrypt(record.plaintext(), point(risk_pk[i][0], risk_pk[i][1]), lock.eph_risk[i]), ct_risk[i]);
    }

    assert_eq(total_in, change.value + lock.amount, "value not conserved");
}
