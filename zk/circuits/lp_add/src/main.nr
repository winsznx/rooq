// Adds liquidity from two LP locks, one per token, into a private LP claim (SPOT-04). Same arithmetic as SpotPool.addLiquidity:
// the first deposit burns MINIMUM_LIQUIDITY against donation attacks, later deposits are taken at the current ratio, and the
// unused side returns to the owner as a FREE note.
use rooq_zk::{
    assert_le, encrypt, floor_div, floor_sqrt, FREE_DOMAIN, Lock, LP_CT_LEN, LpClaim, merkle_root, min, note_commitment, note_inner,
    NOTE_CT_LEN, output_rho, point, POOL_CT_LEN, pool_head, pool_plaintext, PoolState, rec_nonce, rec_nullifier, RESERVE_BITS, ROLE_LP,
    TREE_DEPTH,
};

global KEYS: u32 = 3;
global MINIMUM_LIQUIDITY: Field = 1000;

struct Held {
    lock: Lock,
    index: Field,
    path: [Field; TREE_DEPTH],
}

fn main(
    lock0: Held,
    lock1: Held,
    state: PoolState,
    new_blind: Field,
    lp_salt: Field,
    lp_blind: Field,
    lp_eph: [Field; 4],
    refund_blind: [Field; 2],
    refund_eph: [Field; 2],
    pool_eph: [Field; KEYS],
    root: pub Field,
    nf: pub [Field; 2],
    head: pub Field,
    new_head: pub Field,
    cm_lp: pub Field,
    ct_lp: pub [[Field; LP_CT_LEN]; 4],
    cm_refund: pub [Field; 2],
    ct_refund: pub [[Field; NOTE_CT_LEN]; 2],
    ct_pool: pub [[Field; POOL_CT_LEN]; KEYS],
    deployment: pub Field,
    now: pub Field,
    pool: pub Field,
    token0: pub Field,
    token1: pub Field,
    keys: pub [[Field; 2]; KEYS],
) {
    let (a, b) = (lock0.lock, lock1.lock);
    for held in [lock0, lock1] {
        let cm = held.lock.commit(deployment);
        assert_eq(merkle_root(cm, held.index, held.path), root, "lock not in tree");
    }
    assert_eq(rec_nullifier(a.commit(deployment), a.rec_nonce), nf[0]);
    assert_eq(rec_nullifier(b.commit(deployment), b.rec_nonce), nf[1]);
    assert((a.role == ROLE_LP) & (b.role == ROLE_LP), "not an LP lock");
    assert((a.market == pool) & (b.market == pool), "wrong pool");
    assert((a.t2 == 0) & (b.t2 == 1), "wrong sides");
    assert((a.asset == token0) & (b.asset == token1), "wrong assets");
    assert((a.t4 == b.t4) & (a.t3 == b.t3), "locks are not linked");
    assert((a.owner_auth == b.owner_auth) & (a.owner_x == b.owner_x) & (a.owner_y == b.owner_y), "different owners");
    now.assert_max_bit_size::<64>();
    assert((!a.expiry.lt(now)) & (!b.expiry.lt(now)), "intent expired");
    a.amount.assert_max_bit_size::<RESERVE_BITS>();
    b.amount.assert_max_bit_size::<RESERVE_BITS>();

    if head == 0 {
        assert((state.r0 == 0) & (state.r1 == 0) & (state.supply == 0) & (state.last_leaf == 0), "fresh pool has state");
    } else {
        assert_eq(pool_head(deployment, pool, state), head, "head mismatch");
    }
    let leaf0 = lock0.index + 1;
    let leaf1 = lock1.index + 1;
    assert(state.last_leaf.lt(leaf0) & state.last_leaf.lt(leaf1), "intent out of order");
    let leaf = if leaf0.lt(leaf1) { leaf1 } else { leaf0 };

    let (d0, d1) = (a.amount, b.amount);
    let (used0, used1, shares, supply_next) = if state.supply == 0 {
        let s = floor_sqrt(d0 * d1);
        assert(MINIMUM_LIQUIDITY.lt(s), "insufficient liquidity minted");
        (d0, d1, s - MINIMUM_LIQUIDITY, s)
    } else {
        let optimal1 = floor_div(d0 * state.r1, state.r0);
        let (x0, x1) = if !d1.lt(optimal1) { (d0, optimal1) } else { (floor_div(d1 * state.r0, state.r1), d1) };
        let minted = min(floor_div(x0 * state.supply, state.r0), floor_div(x1 * state.supply, state.r1));
        (x0, x1, minted, state.supply + minted)
    };
    assert(shares != 0, "insufficient liquidity minted");
    assert_le(a.t3, shares);

    let (r0, r1) = (state.r0 + used0, state.r1 + used1);
    r0.assert_max_bit_size::<RESERVE_BITS>();
    r1.assert_max_bit_size::<RESERVE_BITS>();
    let next = PoolState { r0, r1, supply: supply_next, last_leaf: leaf, blind: new_blind };
    assert_eq(pool_head(deployment, pool, next), new_head);
    let plain = pool_plaintext(next);
    for i in 0..KEYS {
        assert_eq(encrypt(plain, point(keys[i][0], keys[i][1]), pool_eph[i]), ct_pool[i]);
    }

    let claim = LpClaim {
        pool,
        shares,
        owner_auth: a.owner_auth,
        owner_x: a.owner_x,
        owner_y: a.owner_y,
        expiry: 0,
        min0: 0,
        min1: 0,
        rec_nonce: rec_nonce(nf[0], nf[1], 0, lp_salt),
        blind: lp_blind,
    };
    assert_eq(claim.commit(deployment), cm_lp);
    let lp_plain = claim.plaintext();
    let owner_key = point(a.owner_x, a.owner_y);
    let lp_keys = [owner_key, point(keys[0][0], keys[0][1]), point(keys[1][0], keys[1][1]), point(keys[2][0], keys[2][1])];
    for i in 0..4 {
        assert_eq(encrypt(lp_plain, lp_keys[i], lp_eph[i]), ct_lp[i]);
    }

    let refunds = [(d0 - used0, token0), (d1 - used1, token1)];
    for i in 0..2 {
        let (value, asset) = refunds[i];
        let rho = output_rho(nf[0], nf[1], i as Field);
        assert_eq(cm_refund[i], note_commitment(deployment, FREE_DOMAIN, asset, value, note_inner(a.owner(), rho, refund_blind[i])));
        assert_eq(encrypt([FREE_DOMAIN, asset, value, rho, refund_blind[i]], owner_key, refund_eph[i]), ct_refund[i]);
    }
}
