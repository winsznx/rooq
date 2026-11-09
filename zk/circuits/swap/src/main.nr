// Executes a swap intent against one pool or two (SPOT-01..03, D-18). The operator proves it from the intent's committed
// limits and the private pool state. The trader's limits bind: asset in, amount, minimum out, route, payout address, expiry.
//
// Intents run in increasing tree order per pool, so an operator cannot reorder trades or place its own ahead of one it has
// already seen. It can only leave an intent out, and that intent refunds at expiry. A two-hop route settles atomically in one
// proof, so no intermediate asset is ever held.
use rooq_zk::{
    amount_out, encrypt, FREE_DOMAIN, Lock, merkle_root, note_commitment, note_inner, NOTE_CT_LEN, output_rho, point, POOL_CT_LEN,
    pool_head, pool_plaintext, PoolState, rec_nullifier, RESERVE_BITS, ROLE_SWAP, TREE_DEPTH,
};

global KEYS: u32 = 3;

struct Hop {
    state: PoolState,
    new_blind: Field,
    eph: [Field; KEYS],
}

fn apply(
    h: Hop,
    amount_in: Field,
    asset_in: Field,
    token0: Field,
    token1: Field,
    fee_bps: Field,
    leaf: Field,
    deployment: Field,
    pool: Field,
    head: Field,
    new_head: Field,
    keys: [[Field; 2]; KEYS],
    ct: [[Field; POOL_CT_LEN]; KEYS],
) -> (Field, Field) {
    let s = h.state;
    assert_eq(pool_head(deployment, pool, s), head, "head mismatch");
    assert(s.last_leaf.lt(leaf), "intent out of order");
    assert((asset_in == token0) | (asset_in == token1), "asset not in pool");
    let zero_for_one = asset_in == token0;
    let (r_in, r_out) = if zero_for_one { (s.r0, s.r1) } else { (s.r1, s.r0) };
    let out = amount_out(amount_in, r_in, r_out, fee_bps);
    assert(out != 0, "zero output");
    let (r_in_next, r_out_next) = (r_in + amount_in, r_out - out);
    r_in_next.assert_max_bit_size::<RESERVE_BITS>();
    let (r0, r1) = if zero_for_one { (r_in_next, r_out_next) } else { (r_out_next, r_in_next) };
    let next = PoolState { r0, r1, supply: s.supply, last_leaf: leaf, blind: h.new_blind };
    assert_eq(pool_head(deployment, pool, next), new_head);
    let plain = pool_plaintext(next);
    for i in 0..KEYS {
        assert_eq(encrypt(plain, point(keys[i][0], keys[i][1]), h.eph[i]), ct[i]);
    }
    (out, if zero_for_one { token1 } else { token0 })
}

fn main(
    intent: Lock,
    index: Field,
    path: [Field; TREE_DEPTH],
    hop0: Hop,
    hop1: Hop,
    out_blind: Field,
    out_eph: Field,
    root: pub Field,
    nf: pub Field,
    cm_out: pub Field,
    ct_out: pub [Field; NOTE_CT_LEN],
    deployment: pub Field,
    now: pub Field,
    pool: pub [Field; 2],
    token0: pub [Field; 2],
    token1: pub [Field; 2],
    fee_bps: pub [Field; 2],
    head: pub [Field; 2],
    new_head: pub [Field; 2],
    ct_pool: pub [[[Field; POOL_CT_LEN]; KEYS]; 2],
    keys: pub [[Field; 2]; KEYS],
) {
    let cm = intent.commit(deployment);
    assert_eq(merkle_root(cm, index, path), root, "intent not in tree");
    assert_eq(rec_nullifier(cm, intent.rec_nonce), nf);
    assert_eq(intent.role, ROLE_SWAP, "not a swap intent");
    assert_eq(intent.market, pool[0], "wrong pool");
    now.assert_max_bit_size::<64>();
    assert(!intent.expiry.lt(now), "intent expired");
    intent.amount.assert_max_bit_size::<RESERVE_BITS>();
    let leaf = index + 1;

    let (first_out, first_asset) = apply(hop0, intent.amount, intent.asset, token0[0], token1[0], fee_bps[0], leaf, deployment, pool[0], head[0], new_head[0], keys, ct_pool[0]);
    let mut out = first_out;
    let mut asset = first_asset;
    if intent.t4 != 0 {
        assert_eq(intent.t4, pool[1], "wrong second pool");
        assert(pool[0] != pool[1], "same pool twice");
        let (second_out, second_asset) = apply(hop1, first_out, first_asset, token0[1], token1[1], fee_bps[1], leaf, deployment, pool[1], head[1], new_head[1], keys, ct_pool[1]);
        out = second_out;
        asset = second_asset;
    } else {
        assert_eq(pool[1], 0, "unused second pool");
        assert_eq(new_head[1], 0, "unused second pool");
    }
    assert(!out.lt(intent.t3), "below minimum output");

    let rho = output_rho(nf, 0, 0);
    let key = point(intent.owner_x, intent.owner_y);
    assert_eq(cm_out, note_commitment(deployment, FREE_DOMAIN, asset, out, note_inner(intent.owner(), rho, out_blind)));
    assert_eq(encrypt([FREE_DOMAIN, asset, out, rho, out_blind], key, out_eph), ct_out);
}
