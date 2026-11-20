// Whole-circuit executions of the protocol share on a one-hop swap at 30 bps. The pool holds 1e6 token0 against 4e6 token1,
// with accruals of 5 and 9 already in it. Expected outputs are SpotMath.getAmountOut, the same with or without a share.
use crate::{Hop, main};
use rooq_zk::{
    encrypt, FREE_DOMAIN, h, Lock, merkle_root, NOTE_CT_LEN, note_commitment, note_inner, output_rho, POOL_CT_LEN, pool_head,
    pool_plaintext, PoolState, rec_nullifier, ROLE_SWAP, T_NODE, TREE_DEPTH,
};
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul};

global DEPLOYMENT: Field = 31337;
global POOL: Field = 1;
global TOKEN0: Field = 0xa0;
global TOKEN1: Field = 0xa1;
global NOW: Field = 1_000_000;
global FEE_BPS: Field = 30;
global INDEX: Field = 4;

fn key(sk: Field) -> EmbeddedCurvePoint {
    fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(sk))
}

/// Swaps `amount_in` of `asset_in`, expecting the trader to get `out` and the protocol to accrue `cut`.
fn swap(asset_in: Field, amount_in: Field, protocol_bps: Field, out: Field, cut: Field) {
    let owner = key(12);
    let intent = Lock {
        asset: asset_in,
        amount: amount_in,
        owner_auth: 16,
        owner_x: owner.x,
        owner_y: owner.y,
        role: ROLE_SWAP,
        market: POOL,
        t2: 0,
        t3: out,
        t4: 0,
        expiry: NOW + 3600,
        rec_nonce: 21,
        blind: 22,
    };
    let mut path = [0; TREE_DEPTH];
    let mut z = 0;
    for i in 0..TREE_DEPTH {
        path[i] = z;
        z = h([T_NODE, z, z]);
    }
    let cm = intent.commit(DEPLOYMENT);
    let nf = rec_nullifier(cm, intent.rec_nonce);

    let state = PoolState { r0: 1_000_000, r1: 4_000_000, supply: 2_000_000, last_leaf: 3, proto0: 5, proto1: 9, blind: 41 };
    let zero_for_one = asset_in == TOKEN0;
    let next = if zero_for_one {
        PoolState {
            r0: state.r0 + amount_in - cut,
            r1: state.r1 - out,
            supply: state.supply,
            last_leaf: INDEX + 1,
            proto0: state.proto0 + cut,
            proto1: state.proto1,
            blind: 42,
        }
    } else {
        PoolState {
            r0: state.r0 - out,
            r1: state.r1 + amount_in - cut,
            supply: state.supply,
            last_leaf: INDEX + 1,
            proto0: state.proto0,
            proto1: state.proto1 + cut,
            blind: 42,
        }
    };
    let k = [key(31), key(32), key(33)];
    let keys = [[k[0].x, k[0].y], [k[1].x, k[1].y], [k[2].x, k[2].y]];
    let pool_eph = [61, 62, 63];
    let mut ct_pool: [[[Field; POOL_CT_LEN]; 3]; 2] = [[[0; POOL_CT_LEN]; 3]; 2];
    for i in 0..3 {
        ct_pool[0][i] = encrypt(pool_plaintext(next), k[i], pool_eph[i]);
    }
    let asset_out = if zero_for_one { TOKEN1 } else { TOKEN0 };
    let rho = output_rho(nf, 0, 0);
    let ct_out: [Field; NOTE_CT_LEN] = encrypt([FREE_DOMAIN, asset_out, out, rho, 81], owner, 82);
    let unused = Hop { state, new_blind: 0, eph: [0; 3] };
    main(
        intent,
        INDEX,
        path,
        Hop { state, new_blind: 42, eph: pool_eph },
        unused,
        81,
        82,
        merkle_root(cm, INDEX, path),
        nf,
        note_commitment(DEPLOYMENT, FREE_DOMAIN, asset_out, out, note_inner(intent.owner(), rho, 81)),
        ct_out,
        DEPLOYMENT,
        NOW,
        [POOL, 0],
        [TOKEN0, 0],
        [TOKEN1, 0],
        [FEE_BPS, 0],
        [protocol_bps, 0],
        [pool_head(DEPLOYMENT, POOL, state), 0],
        [pool_head(DEPLOYMENT, POOL, next), 0],
        ct_pool,
        keys,
    );
}

#[test]
fn zero_share_leaves_swap_as_before() {
    // The whole input enters the reserve and the trader gets the pre-share output.
    swap(TOKEN0, 10_000, 0, 39_486, 0);
}

#[test]
fn share_accrues_floor_of_fee_times_share() {
    // floor(10,000 * 30 * 2,500 / 10,000^2) = floor(7.5) = 7; the trader's output is unchanged.
    swap(TOKEN0, 10_000, 2_500, 39_486, 7);
}

#[test]
fn share_accrues_on_the_input_side() {
    // floor(40,000 * 30 * 2,500 / 10,000^2) = 30, into proto1.
    swap(TOKEN1, 40_000, 2_500, 9_871, 30);
}

#[test(should_fail)]
fn share_rounded_up_refused() {
    swap(TOKEN0, 10_000, 2_500, 39_486, 8);
}

#[test(should_fail)]
fn share_above_bps_refused() {
    swap(TOKEN0, 10_000, 10_001, 39_486, 30);
}
