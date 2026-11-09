// Executes an owner's removal request against the private pool state (SPOT-04). Same arithmetic as SpotPool.removeLiquidity.
// The owner's minimums and expiry bind, and the output can only go to the owner committed in the claim. Unlike every other
// transition this keeps the leaf order rule but never needs a fresh price, so LPs can leave in any market state (D-04).
use rooq_zk::{
    encrypt, floor_div, FREE_DOMAIN, LpClaim, merkle_root, note_commitment, note_inner, NOTE_CT_LEN, output_rho, owner_tag, point, POOL_CT_LEN,
    pool_head, pool_plaintext, PoolState, rec_nullifier, TREE_DEPTH,
};

global KEYS: u32 = 3;

fn main(
    claim: LpClaim,
    index: Field,
    path: [Field; TREE_DEPTH],
    state: PoolState,
    new_blind: Field,
    out_blind: [Field; 2],
    out_eph: [Field; 2],
    pool_eph: [Field; KEYS],
    root: pub Field,
    nf: pub Field,
    head: pub Field,
    new_head: pub Field,
    cm_out: pub [Field; 2],
    ct_out: pub [[Field; NOTE_CT_LEN]; 2],
    ct_pool: pub [[Field; POOL_CT_LEN]; KEYS],
    deployment: pub Field,
    now: pub Field,
    pool: pub Field,
    token0: pub Field,
    token1: pub Field,
    keys: pub [[Field; 2]; KEYS],
) {
    let cm = claim.commit(deployment);
    assert_eq(merkle_root(cm, index, path), root, "claim not in tree");
    assert_eq(rec_nullifier(cm, claim.rec_nonce), nf);
    assert_eq(claim.pool, pool, "wrong pool");
    assert_eq(pool_head(deployment, pool, state), head, "head mismatch");
    assert(claim.expiry != 0, "no open request");
    now.assert_max_bit_size::<64>();
    assert(!claim.expiry.lt(now), "request expired");
    let leaf = index + 1;
    assert(state.last_leaf.lt(leaf), "intent out of order");
    assert(state.supply != 0, "empty pool");
    assert(!state.supply.lt(claim.shares), "shares above supply");

    let (a0, a1) = (floor_div(claim.shares * state.r0, state.supply), floor_div(claim.shares * state.r1, state.supply));
    assert(!a0.lt(claim.min0), "below minimum output");
    assert(!a1.lt(claim.min1), "below minimum output");
    let next = PoolState { r0: state.r0 - a0, r1: state.r1 - a1, supply: state.supply - claim.shares, last_leaf: leaf, blind: new_blind };
    assert_eq(pool_head(deployment, pool, next), new_head);
    let plain = pool_plaintext(next);
    for i in 0..KEYS {
        assert_eq(encrypt(plain, point(keys[i][0], keys[i][1]), pool_eph[i]), ct_pool[i]);
    }

    let key = point(claim.owner_x, claim.owner_y);
    let owner = owner_tag(claim.owner_auth, key);
    let outs = [(a0, token0), (a1, token1)];
    for i in 0..2 {
        let (value, asset) = outs[i];
        let rho = output_rho(nf, 0, i as Field);
        assert_eq(cm_out[i], note_commitment(deployment, FREE_DOMAIN, asset, value, note_inner(owner, rho, out_blind[i])));
        assert_eq(encrypt([FREE_DOMAIN, asset, value, rho, out_blind[i]], key, out_eph[i]), ct_out[i]);
    }
}
