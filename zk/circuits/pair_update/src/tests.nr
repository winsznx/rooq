// Whole-circuit executions of the health, cooldown and cure rules. A long of 4 units at 250 on a 6-decimal asset:
// initial margin 100 USDG (10%), maintenance 50 USDG (5%), no funding moving. Also the relay fee, taken from the out note.
use crate::{main, NoteIn};
use rooq_zk::{
    auth_key, encrypt, FREE_DOMAIN, h, merkle_root, note_commitment, note_inner, NOTE_CT_LEN, nullifier_key, OI_REDUCE,
    oi_delta, output_rho, owner_nullifier, owner_tag, Pair, PAIR_CT_LEN, point, rec_nonce, rec_nullifier, RelayFee,
    settle_funding, T_NODE, TAKER_GRACE, TREE_DEPTH, WAD,
};
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul};

global DEPLOYMENT: Field = 31337;
global MARKET: Field = 1;
global ASSET: Field = 0xa0;
global SCALE: Field = 1_000_000_000_000;
global ENTRY: Field = 250 * WAD;
global IMR: Field = WAD / 10;
global MMR: Field = WAD / 20;
global FUNDING_ZERO: Field = 0x100000000000000000000000000000000;
global OPENED_AT: Field = 1_000_000;
global GAP: Field = 600;
global USDG: Field = 1_000_000;
global TAKER_SK: Field = 11;
global MAKER_SK: Field = 22;
global NOTE_VALUE: Field = 100 * USDG;

fn key(sk: Field) -> EmbeddedCurvePoint {
    fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(sk))
}

fn pair_with(taker_margin: Field, maker_margin: Field) -> Pair {
    let t = key(TAKER_SK);
    let m = key(MAKER_SK);
    Pair {
        market: MARKET,
        asset: ASSET,
        is_short: 0,
        size: 4 * WAD,
        entry: ENTRY,
        funding_index: FUNDING_ZERO,
        close_spread: 10,
        funding_debt: 0,
        debt_by_taker: 0,
        last_reduce: 0,
        updated_at: OPENED_AT,
        taker_margin,
        maker_margin,
        taker_auth: auth_key(TAKER_SK),
        taker_x: t.x,
        taker_y: t.y,
        maker_auth: auth_key(MAKER_SK),
        maker_x: m.x,
        maker_y: m.y,
        rec_nonce: 5,
        blind: 6,
    }
}

/// Paths for a tree holding `a` at leaf 0 and `b` at leaf 1.
fn two_leaf_paths(a: Field, b: Field) -> ([Field; TREE_DEPTH], [Field; TREE_DEPTH]) {
    let mut pa = [0; TREE_DEPTH];
    let mut pb = [0; TREE_DEPTH];
    pa[0] = b;
    pb[0] = a;
    let mut z = 0;
    for i in 1..TREE_DEPTH {
        z = h([T_NODE, z, z]);
        pa[i] = z;
        pb[i] = z;
    }
    (pa, pb)
}

fn update(pair: Pair, actor: Field, add: Field, remove: Field, mark: Field, as_of: Field) {
    let self_sk = if actor == 2 { MAKER_SK } else { TAKER_SK };
    let zero_fee_to_self = RelayFee { value: 0, auth: auth_key(self_sk), pk: key(self_sk), blind: 65, eph: 66 };
    update_paying(pair, actor, add, remove, mark, as_of, zero_fee_to_self, NOTE_VALUE - add + remove);
}

/// A cure inside the cooldown keeps the replaced version's clock. Any other update restarts it at `as_of`.
fn clock_after(pair: Pair, as_of: Field) -> Field {
    if as_of.lt(pair.updated_at + GAP) { pair.updated_at } else { as_of }
}

fn fee_to_relayer(value: Field) -> RelayFee {
    RelayFee { value, auth: 67, pk: key(68), blind: 65, eph: 66 }
}

/// Builds every public output for an update with no reduce and no funding change, then runs the circuit.
fn update_paying(
    pair: Pair,
    actor: Field,
    add: Field,
    remove: Field,
    mark: Field,
    as_of: Field,
    relay: RelayFee,
    out_value: Field,
) {
    let spender_sk = if actor == 2 { MAKER_SK } else { TAKER_SK };
    let spender_pk = key(spender_sk);
    let spender = owner_tag(auth_key(spender_sk), spender_pk);
    let note_cm = note_commitment(DEPLOYMENT, FREE_DOMAIN, ASSET, NOTE_VALUE, note_inner(spender, 7, 8));
    let pair_cm = pair.commit(DEPLOYMENT);
    let (pair_path, note_path) = two_leaf_paths(pair_cm, note_cm);
    let root = merkle_root(pair_cm, 0, pair_path);
    let nf = [rec_nullifier(pair_cm, pair.rec_nonce), owner_nullifier(nullifier_key(spender_sk), note_cm)];

    let (mut taker_margin, mut maker_margin) = (pair.taker_margin, pair.maker_margin);
    if actor == 1 {
        taker_margin = taker_margin + add - remove;
    } else if actor == 2 {
        maker_margin = maker_margin + add - remove;
    }
    let salt = 41;
    let mut next = pair;
    next.taker_margin = taker_margin;
    next.maker_margin = maker_margin;
    next.updated_at = clock_after(pair, as_of);
    next.rec_nonce = rec_nonce(nf[0], nf[1], 0, salt);
    next.blind = 42;

    let risk = [key(101), key(102)];
    let fee_pk = key(103);
    let fee_auth = 104;
    let keys = [point(pair.taker_x, pair.taker_y), point(pair.maker_x, pair.maker_y), risk[0], risk[1]];
    let pair_eph = [51, 52, 53, 54];
    let mut ct_pair = [[0; PAIR_CT_LEN]; 4];
    for i in 0..4 {
        ct_pair[i] = encrypt(next.plaintext(), keys[i], pair_eph[i]);
    }
    let (out_auth, out_key) = if actor == 2 { (pair.maker_auth, keys[1]) } else { (pair.taker_auth, keys[0]) };
    let out_rho = output_rho(nf[0], nf[1], 1);
    let fee_rho = output_rho(nf[0], nf[1], 2);
    let ct_out: [Field; NOTE_CT_LEN] = encrypt([FREE_DOMAIN, ASSET, out_value, out_rho, 61], out_key, 62);
    let ct_fee: [Field; NOTE_CT_LEN] = encrypt([FREE_DOMAIN, ASSET, 0, fee_rho, 63], fee_pk, 64);
    let (cm_relay, ct_relay) = relay.note(DEPLOYMENT, ASSET, nf[0], nf[1], 3);

    main(
        pair,
        0,
        pair_path,
        actor,
        if actor == 0 { 0 } else { spender_sk },
        spender_sk,
        spender_pk,
        NoteIn { value: NOTE_VALUE, rho: 7, blind: 8, index: 1, path: note_path },
        add,
        remove,
        0,
        salt,
        42,
        pair_eph,
        61,
        62,
        63,
        64,
        relay,
        root,
        nf,
        next.commit(DEPLOYMENT),
        note_commitment(DEPLOYMENT, FREE_DOMAIN, ASSET, out_value, note_inner(owner_tag(out_auth, out_key), out_rho, 61)),
        note_commitment(DEPLOYMENT, FREE_DOMAIN, ASSET, 0, note_inner(owner_tag(fee_auth, fee_pk), fee_rho, 63)),
        ct_pair,
        ct_out,
        ct_fee,
        DEPLOYMENT,
        MARKET,
        ASSET,
        mark,
        IMR,
        SCALE,
        10,
        FUNDING_ZERO,
        oi_delta(DEPLOYMENT, MARKET, 0, 0, OI_REDUCE, 0, 0, next.rec_nonce),
        [[risk[0].x, risk[0].y], [risk[1].x, risk[1].y]],
        fee_auth,
        [fee_pk.x, fee_pk.y],
        0,
        MMR,
        as_of,
        GAP,
        cm_relay,
        ct_relay,
    );
}

global MARK: Field = ENTRY;
global AFTER_GAP: Field = OPENED_AT + GAP;
global AFTER_GRACE: Field = AFTER_GAP + TAKER_GRACE;
global INSIDE_GAP: Field = OPENED_AT + GAP - 1;

#[test]
fn keyless_settlement_after_the_cooldown() {
    update(pair_with(60 * USDG, 200 * USDG), 0, 0, 0, MARK, AFTER_GRACE);
}

#[test(should_fail_with = "update leaves pair liquidatable")]
fn keyless_no_op_on_a_liquidatable_pair() {
    update(pair_with(49 * USDG, 200 * USDG), 0, 0, 0, MARK, AFTER_GRACE);
}

#[test]
fn keyless_no_op_without_a_mark_skips_the_health_rule() {
    update(pair_with(49 * USDG, 200 * USDG), 0, 0, 0, 0, AFTER_GRACE);
}

#[test(should_fail_with = "update cooldown")]
fn keyless_settlement_inside_the_cooldown() {
    update(pair_with(150 * USDG, 200 * USDG), 0, 0, 0, MARK, INSIDE_GAP);
}

#[test(should_fail_with = "update cooldown")]
fn maker_add_of_zero_inside_the_cooldown() {
    update(pair_with(150 * USDG, 200 * USDG), 2, 0, 0, MARK, INSIDE_GAP);
}

#[test(should_fail_with = "update cooldown")]
fn taker_add_above_initial_margin_inside_the_cooldown() {
    update(pair_with(150 * USDG, 200 * USDG), 1, 10 * USDG, 0, MARK, INSIDE_GAP);
}

#[test(should_fail_with = "update cooldown")]
fn taker_add_without_a_mark_inside_the_cooldown() {
    update(pair_with(80 * USDG, 200 * USDG), 1, 20 * USDG, 0, 0, INSIDE_GAP);
}

#[test]
fn below_im_taker_add_reaching_im_inside_the_cooldown() {
    update(pair_with(80 * USDG, 200 * USDG), 1, 20 * USDG, 0, MARK, INSIDE_GAP);
}

#[test(should_fail_with = "cure must reach initial margin")]
fn below_im_taker_add_short_of_im_inside_the_cooldown() {
    update(pair_with(80 * USDG, 200 * USDG), 1, 20 * USDG - 1, 0, MARK, INSIDE_GAP);
}

#[test]
fn taker_add_that_cures_maintenance_inside_the_cooldown() {
    update(pair_with(40 * USDG, 200 * USDG), 1, 60 * USDG, 0, MARK, INSIDE_GAP);
}

#[test(should_fail_with = "cure must reach initial margin")]
fn taker_add_above_maintenance_but_short_of_im_inside_the_cooldown() {
    update(pair_with(40 * USDG, 200 * USDG), 1, 30 * USDG, 0, MARK, INSIDE_GAP);
}

#[test]
fn taker_add_that_cures_maintenance_after_the_cooldown() {
    update(pair_with(40 * USDG, 200 * USDG), 1, 10 * USDG, 0, MARK, AFTER_GAP);
}

#[test(should_fail_with = "update leaves pair liquidatable")]
fn taker_add_short_of_maintenance_after_the_cooldown() {
    update(pair_with(40 * USDG, 200 * USDG), 1, 10 * USDG - 1, 0, MARK, AFTER_GAP);
}

#[test(should_fail_with = "update leaves pair liquidatable")]
fn maker_add_cannot_keep_a_taker_bad_pair_alive() {
    update(pair_with(40 * USDG, 200 * USDG), 2, 50 * USDG, 0, MARK, AFTER_GRACE);
}

#[test(should_fail_with = "update cooldown")]
fn maker_cure_waiver_needs_the_maker_side_below_im() {
    update(pair_with(40 * USDG, 200 * USDG), 2, 50 * USDG, 0, MARK, INSIDE_GAP);
}

#[test(should_fail_with = "update cooldown")]
fn removal_never_takes_the_cure_waiver() {
    update(pair_with(150 * USDG, 200 * USDG), 1, 0, 10 * USDG, MARK, INSIDE_GAP);
}

#[test]
fn removal_to_initial_margin_after_the_cooldown() {
    update(pair_with(150 * USDG, 200 * USDG), 1, 0, 50 * USDG, MARK, AFTER_GAP);
}

#[test]
fn below_im_maker_add_reaching_im_inside_the_cooldown() {
    update(pair_with(200 * USDG, 80 * USDG), 2, 20 * USDG, 0, MARK, INSIDE_GAP);
}

#[test]
fn zero_relay_fee_to_self_for_each_actor() {
    update(pair_with(150 * USDG, 200 * USDG), 0, 0, 0, MARK, AFTER_GRACE);
    update(pair_with(150 * USDG, 200 * USDG), 1, 0, 0, MARK, AFTER_GAP);
    update(pair_with(150 * USDG, 200 * USDG), 2, 0, 0, MARK, AFTER_GRACE);
}

#[test]
fn owner_pays_the_relay_fee_from_its_out_note() {
    let pair = pair_with(150 * USDG, 200 * USDG);
    update_paying(pair, 1, 0, 50 * USDG, MARK, AFTER_GAP, fee_to_relayer(5 * USDG), NOTE_VALUE + 45 * USDG);
    update_paying(pair, 2, 10 * USDG, 0, MARK, AFTER_GRACE, fee_to_relayer(NOTE_VALUE - 10 * USDG), 0);
}

#[test(should_fail_with = "fee needs the owner key")]
fn keyless_settlement_cannot_pay_a_fee() {
    update_paying(pair_with(150 * USDG, 200 * USDG), 0, 0, 0, MARK, AFTER_GRACE, fee_to_relayer(1), NOTE_VALUE - 1);
}

#[test(should_fail)]
fn relay_fee_must_come_out_of_the_out_note() {
    let fee = fee_to_relayer(5 * USDG);
    update_paying(pair_with(150 * USDG, 200 * USDG), 1, 0, 50 * USDG, MARK, AFTER_GAP, fee, NOTE_VALUE + 50 * USDG);
}

#[test(should_fail_with = "fee above available")]
fn relay_fee_above_the_out_note() {
    update_paying(pair_with(150 * USDG, 200 * USDG), 1, NOTE_VALUE, 0, MARK, AFTER_GAP, fee_to_relayer(1), 0 - 1);
}

#[test(should_fail_with = "taker grace")]
fn maker_add_inside_the_taker_grace() {
    update(pair_with(150 * USDG, 200 * USDG), 2, 10 * USDG, 0, MARK, AFTER_GAP);
}

#[test(should_fail_with = "taker grace")]
fn keyless_settlement_at_the_last_second_of_the_taker_grace() {
    update(pair_with(150 * USDG, 200 * USDG), 0, 0, 0, MARK, AFTER_GRACE - 1);
}

#[test]
fn taker_updates_inside_the_taker_grace() {
    update(pair_with(150 * USDG, 200 * USDG), 1, 0, 0, MARK, AFTER_GAP);
    update(pair_with(150 * USDG, 200 * USDG), 1, 0, 50 * USDG, MARK, AFTER_GRACE - 1);
}

#[test]
fn maker_and_keyless_update_once_the_taker_grace_ends() {
    update(pair_with(150 * USDG, 200 * USDG), 2, 10 * USDG, 0, MARK, AFTER_GRACE);
    update(pair_with(150 * USDG, 200 * USDG), 0, 0, 0, MARK, AFTER_GRACE);
}

#[test]
fn maker_cure_inside_the_cooldown_is_unaffected_by_the_taker_grace() {
    update(pair_with(200 * USDG, 80 * USDG), 2, 20 * USDG, 0, MARK, AFTER_GAP - 1);
}

/// One update with no reduce and no relay fee from `pair` to its next version, returned for chaining.
fn step(pair: Pair, actor: Field, add: Field, mark: Field, index: Field, as_of: Field) -> Pair {
    let spender_sk = if actor == 2 { MAKER_SK } else { TAKER_SK };
    let spender_pk = key(spender_sk);
    let spender = owner_tag(auth_key(spender_sk), spender_pk);
    let note_cm = note_commitment(DEPLOYMENT, FREE_DOMAIN, ASSET, NOTE_VALUE, note_inner(spender, 7, 8));
    let pair_cm = pair.commit(DEPLOYMENT);
    let (pair_path, note_path) = two_leaf_paths(pair_cm, note_cm);
    let root = merkle_root(pair_cm, 0, pair_path);
    let nf = [rec_nullifier(pair_cm, pair.rec_nonce), owner_nullifier(nullifier_key(spender_sk), note_cm)];

    let s = settle_funding(pair, index, SCALE);
    let (mut taker_margin, mut maker_margin) = (s.taker_margin, s.maker_margin);
    if actor == 1 {
        taker_margin = taker_margin + add;
    } else if actor == 2 {
        maker_margin = maker_margin + add;
    }
    let salt = 41;
    let mut next = pair;
    next.funding_index = index;
    next.funding_debt = s.unpaid;
    next.debt_by_taker = if (s.unpaid != 0) & s.taker_pays { 1 } else { 0 };
    next.taker_margin = taker_margin;
    next.maker_margin = maker_margin;
    next.updated_at = clock_after(pair, as_of);
    next.rec_nonce = rec_nonce(nf[0], nf[1], 0, salt);
    next.blind = 42;

    let risk = [key(101), key(102)];
    let fee_pk = key(103);
    let fee_auth = 104;
    let keys = [point(pair.taker_x, pair.taker_y), point(pair.maker_x, pair.maker_y), risk[0], risk[1]];
    let pair_eph = [51, 52, 53, 54];
    let mut ct_pair = [[0; PAIR_CT_LEN]; 4];
    for i in 0..4 {
        ct_pair[i] = encrypt(next.plaintext(), keys[i], pair_eph[i]);
    }
    let (out_auth, out_key) = if actor == 2 { (pair.maker_auth, keys[1]) } else { (pair.taker_auth, keys[0]) };
    let out_value = NOTE_VALUE - add;
    let out_rho = output_rho(nf[0], nf[1], 1);
    let fee_rho = output_rho(nf[0], nf[1], 2);
    let ct_out: [Field; NOTE_CT_LEN] = encrypt([FREE_DOMAIN, ASSET, out_value, out_rho, 61], out_key, 62);
    let ct_fee: [Field; NOTE_CT_LEN] = encrypt([FREE_DOMAIN, ASSET, 0, fee_rho, 63], fee_pk, 64);
    let relay = RelayFee { value: 0, auth: auth_key(spender_sk), pk: spender_pk, blind: 65, eph: 66 };
    let (cm_relay, ct_relay) = relay.note(DEPLOYMENT, ASSET, nf[0], nf[1], 3);
    main(
        pair,
        0,
        pair_path,
        actor,
        if actor == 0 { 0 } else { spender_sk },
        spender_sk,
        spender_pk,
        NoteIn { value: NOTE_VALUE, rho: 7, blind: 8, index: 1, path: note_path },
        add,
        0,
        0,
        salt,
        42,
        pair_eph,
        61,
        62,
        63,
        64,
        relay,
        root,
        nf,
        next.commit(DEPLOYMENT),
        note_commitment(DEPLOYMENT, FREE_DOMAIN, ASSET, out_value, note_inner(owner_tag(out_auth, out_key), out_rho, 61)),
        note_commitment(DEPLOYMENT, FREE_DOMAIN, ASSET, 0, note_inner(owner_tag(fee_auth, fee_pk), fee_rho, 63)),
        ct_pair,
        ct_out,
        ct_fee,
        DEPLOYMENT,
        MARKET,
        ASSET,
        mark,
        IMR,
        SCALE,
        10,
        index,
        oi_delta(DEPLOYMENT, MARKET, 0, 0, OI_REDUCE, 0, 0, next.rec_nonce),
        [[risk[0].x, risk[0].y], [risk[1].x, risk[1].y]],
        fee_auth,
        [fee_pk.x, fee_pk.y],
        0,
        MMR,
        as_of,
        GAP,
        cm_relay,
        ct_relay,
    );
    next
}

// Both sides held by one party, both at exactly IM (100 USDG at 250). Four cures land inside one cooldown, one second
// apart, each after a price move against the side being cured. None of them moves the clock, so the cooldown still ends
// 600 s after the version that opened it.
fn four_alternating_cures() -> Pair {
    let t0 = OPENED_AT + 1;
    // Down to 249: the taker side needs 103.6 USDG.
    let v1 = step(pair_with(100 * USDG, 100 * USDG), 1, 3_600_000, 249 * WAD, FUNDING_ZERO, t0);
    // Up to 251: the maker side needs 104.4 USDG.
    let v2 = step(v1, 2, 4_400_000, 251 * WAD, FUNDING_ZERO, t0 + 1);
    let v3 = step(v2, 1, 100_000, 248_990_000_000_000_000_000, FUNDING_ZERO, t0 + 2);
    step(v3, 2, 100_000, 251_010_000_000_000_000_000, FUNDING_ZERO, t0 + 3)
}

#[test]
fn cures_inside_one_cooldown_keep_the_clock() {
    let v4 = four_alternating_cures();
    assert_eq(v4.updated_at, OPENED_AT);
    // The cooldown and the taker grace end on the opening version's schedule.
    let v5 = step(v4, 1, 0, 251_010_000_000_000_000_000, FUNDING_ZERO, AFTER_GAP);
    assert_eq(v5.updated_at, AFTER_GAP);
}

#[test(should_fail_with = "update cooldown")]
fn cures_do_not_open_the_cooldown_to_ordinary_updates() {
    let v4 = four_alternating_cures();
    let _ = step(v4, 1, 0, 251_010_000_000_000_000_000, FUNDING_ZERO, INSIDE_GAP);
}

#[test(should_fail_with = "taker grace")]
fn cures_do_not_move_the_taker_grace() {
    let v4 = four_alternating_cures();
    let _ = step(v4, 2, 0, 251_010_000_000_000_000_000, FUNDING_ZERO, AFTER_GRACE - 1);
}

// No price move: funding epochs moving the index against the taker reopen the cure waiver, but each cure keeps the clock.
#[test]
fn funding_cures_inside_one_cooldown_keep_the_clock() {
    let v0 = pair_with(100 * USDG, 100 * USDG);
    // 0.25e18 index move: accrued = ceil(4e18 * 2.5e17 / 1e30) = 1 USDG, paid by the long taker.
    let i1 = FUNDING_ZERO + 250_000_000_000_000_000;
    let v1 = step(v0, 1, 1 * USDG, MARK, i1, OPENED_AT + 1);
    let i2 = i1 + 250_000_000_000_000_000;
    let v2 = step(v1, 1, 1 * USDG, MARK, i2, OPENED_AT + 2);
    let i3 = i2 + 250_000_000_000_000_000;
    let v3 = step(v2, 1, 1 * USDG, MARK, i3, OPENED_AT + 3);
    assert_eq(v3.updated_at, OPENED_AT);
    let _ = step(v3, 0, 0, MARK, i3, AFTER_GRACE);
}
