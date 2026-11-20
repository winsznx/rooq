// Pays a spot pool's protocol accruals to the deployment fee address as two FREE notes, one per token, and zeroes them.
// Reserves, supply and last_leaf are untouched, so a sweep never strands an intent. Any pool-key holder can prove it: the
// destination is fixed by the contract.
use rooq_zk::{
    encrypt, FREE_DOMAIN, note_commitment, note_inner, NOTE_CT_LEN, output_rho, owner_tag, point, POOL_CT_LEN, pool_head,
    pool_plaintext, PoolState,
};

global KEYS: u32 = 3;

mod tests;

fn main(
    state: PoolState,
    new_blind: Field,
    out_blind: [Field; 2],
    out_eph: [Field; 2],
    pool_eph: [Field; KEYS],
    head: pub Field,
    new_head: pub Field,
    cm_out: pub [Field; 2],
    ct_out: pub [[Field; NOTE_CT_LEN]; 2],
    ct_pool: pub [[Field; POOL_CT_LEN]; KEYS],
    deployment: pub Field,
    pool: pub Field,
    token0: pub Field,
    token1: pub Field,
    fee_auth: pub Field,
    fee_pk: pub [Field; 2],
    keys: pub [[Field; 2]; KEYS],
) {
    assert_eq(pool_head(deployment, pool, state), head, "head mismatch");
    assert((state.proto0 != 0) | (state.proto1 != 0), "nothing to sweep");
    let next = PoolState {
        r0: state.r0,
        r1: state.r1,
        supply: state.supply,
        last_leaf: state.last_leaf,
        proto0: 0,
        proto1: 0,
        blind: new_blind,
    };
    assert_eq(pool_head(deployment, pool, next), new_head);
    let plain = pool_plaintext(next);
    for i in 0..KEYS {
        assert_eq(encrypt(plain, point(keys[i][0], keys[i][1]), pool_eph[i]), ct_pool[i]);
    }

    let fee_key = point(fee_pk[0], fee_pk[1]);
    let fee_owner = owner_tag(fee_auth, fee_key);
    let outs = [(state.proto0, token0), (state.proto1, token1)];
    for i in 0..2 {
        let (value, asset) = outs[i];
        let rho = output_rho(head, new_head, i as Field);
        assert_eq(cm_out[i], note_commitment(deployment, FREE_DOMAIN, asset, value, note_inner(fee_owner, rho, out_blind[i])));
        assert_eq(encrypt([FREE_DOMAIN, asset, value, rho, out_blind[i]], fee_key, out_eph[i]), ct_out[i]);
    }
}
