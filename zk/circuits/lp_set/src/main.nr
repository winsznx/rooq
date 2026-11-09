// Rewrites an LP claim. Mode 0: the owner requests removal, committing minimum amounts and an expiry. Mode 1: anyone returns an
// expired request to an idle claim, so a request the operator ignores costs the owner nothing.
use rooq_zk::{auth_key, encrypt, LP_CT_LEN, LpClaim, merkle_root, point, rec_nonce, rec_nullifier, TREE_DEPTH};

fn main(
    claim: LpClaim,
    index: Field,
    path: [Field; TREE_DEPTH],
    sk: Field,
    min0: Field,
    min1: Field,
    expiry: Field,
    salt: Field,
    new_blind: Field,
    eph: [Field; 4],
    root: pub Field,
    nf: pub Field,
    cm_next: pub Field,
    ct: pub [[Field; LP_CT_LEN]; 4],
    deployment: pub Field,
    now: pub Field,
    mode: pub Field,
    keys: pub [[Field; 2]; 3],
) {
    let cm = claim.commit(deployment);
    assert_eq(merkle_root(cm, index, path), root, "claim not in tree");
    assert_eq(rec_nullifier(cm, claim.rec_nonce), nf);
    assert(mode * (mode - 1) == 0, "unknown mode");
    now.assert_max_bit_size::<64>();
    expiry.assert_max_bit_size::<64>();
    let (next_expiry, next_min0, next_min1) = if mode == 0 {
        assert_eq(auth_key(sk), claim.owner_auth, "not the owner");
        assert_eq(claim.expiry, 0, "request already open");
        assert(expiry != 0, "request needs an expiry");
        (expiry, min0, min1)
    } else {
        assert(claim.expiry != 0, "no open request");
        assert(claim.expiry.lt(now), "request not expired");
        (0, 0, 0)
    };
    let next = LpClaim {
        pool: claim.pool,
        shares: claim.shares,
        owner_auth: claim.owner_auth,
        owner_x: claim.owner_x,
        owner_y: claim.owner_y,
        expiry: next_expiry,
        min0: next_min0,
        min1: next_min1,
        rec_nonce: rec_nonce(nf, 0, 0, salt),
        blind: new_blind,
    };
    assert_eq(next.commit(deployment), cm_next);
    let plain = next.plaintext();
    let recipients = [point(claim.owner_x, claim.owner_y), point(keys[0][0], keys[0][1]), point(keys[1][0], keys[1][1]), point(keys[2][0], keys[2][1])];
    for i in 0..4 {
        assert_eq(encrypt(plain, recipients[i], eph[i]), ct[i]);
    }
}
