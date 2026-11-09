// Proves the caller is the taker or maker of a live pair, to start a forced exit (REC-03, D-11). The request is keyed by
// the pair's nullifier, so its deadline survives unrelated root updates, and nobody without an owner key can open
// one against someone else's position or freeze anything.
use rooq_zk::{auth_key, merkle_root, Pair, rec_nullifier, TREE_DEPTH};

fn main(pair: Pair, index: Field, path: [Field; TREE_DEPTH], sk: Field, root: pub Field, nf: pub Field, deployment: pub Field) {
    let cm = pair.commit(deployment);
    assert_eq(merkle_root(cm, index, path), root, "pair not in tree");
    assert_eq(rec_nullifier(cm, pair.rec_nonce), nf);
    let auth = auth_key(sk);
    assert((auth == pair.taker_auth) | (auth == pair.maker_auth), "not an owner of this pair");
}
