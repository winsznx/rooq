// Replaces a live pair with its next version, settling funding (PERP-03, PERP-04, D-03, D-14).
//
//   actor 0  No key. Settles funding only, so funding keeps moving while both owners are away.
//   actor 1  The taker. May add or remove margin and reduce size at the mark less the maker's standing close spread,
//            paying the market fee on the reduced part.
//   actor 2  The maker. May add or remove its own margin.
//
// Reduce and remove need a fresh oracle (mark != 0): adding margin and settling funding do not (LIQ-08). Removal leaves the
// actor at initial margin, with gains counted only up to what the counterparty posted. An update always publishes the
// same shape, including an open-interest change of size 0 when nothing was reduced, so actions look alike on chain.
// When the pair has a pending exit request, `carried_nf` names the next version so the request and its deadline move with it
// (REC-03). It is 0 otherwise, so ordinary updates stay unlinked.
use rooq_zk::{
    assert_amount, auth_key, below, BPS, ceil_div, encrypt, fee, floor_div, FREE_DOMAIN, margin_requirement, merkle_root, min,
    note_commitment, note_inner, NOTE_CT_LEN, nullifier_key, oi_delta, output_rho, owner_nullifier, owner_tag, Pair,
    PAIR_CT_LEN, pair_pnl, PairPnl, point, PRICE_BITS, rec_nonce, rec_nullifier, settle_funding, SIZE_BITS, TREE_DEPTH,
};
use std::embedded_curve_ops::EmbeddedCurvePoint;

struct NoteIn {
    value: Field,
    rho: Field,
    blind: Field,
    index: Field,
    path: [Field; TREE_DEPTH],
}

fn main(
    pair: Pair,
    index: Field,
    path: [Field; TREE_DEPTH],
    actor: Field,
    sk: Field,
    spender_sk: Field,
    spender_pk: EmbeddedCurvePoint,
    note: NoteIn,
    add: Field,
    remove: Field,
    reduce: Field,
    salt: Field,
    new_blind: Field,
    pair_eph: [Field; 4],
    out_blind: Field,
    out_eph: Field,
    fee_blind: Field,
    fee_eph: Field,
    root: pub Field,
    nf: pub [Field; 2],
    cm_pair: pub Field,
    cm_out: pub Field,
    cm_fee: pub Field,
    ct_pair: pub [[Field; PAIR_CT_LEN]; 4],
    ct_out: pub [Field; NOTE_CT_LEN],
    ct_fee: pub [Field; NOTE_CT_LEN],
    deployment: pub Field,
    market: pub Field,
    asset: pub Field,
    mark: pub Field,
    imr_wad: pub Field,
    scale: pub Field,
    fee_bps: pub Field,
    funding_index: pub Field,
    delta_cm: pub Field,
    risk_pk: pub [[Field; 2]; 2],
    fee_auth: pub Field,
    fee_pk: pub [Field; 2],
    carried_nf: pub Field,
) {
    let cm = pair.commit(deployment);
    assert_eq(merkle_root(cm, index, path), root, "pair not in tree");
    assert_eq(rec_nullifier(cm, pair.rec_nonce), nf[0]);
    assert_eq(pair.market, market, "wrong market");
    assert_eq(pair.asset, asset);
    mark.assert_max_bit_size::<PRICE_BITS>();

    assert(actor * (actor - 1) * (actor - 2) == 0, "unknown actor");
    assert_amount(add);
    assert_amount(remove);
    reduce.assert_max_bit_size::<SIZE_BITS>();
    assert(reduce.lt(pair.size), "reduce must leave a position");
    if actor == 0 {
        assert((add == 0) & (remove == 0) & (reduce == 0), "no key: funding only");
    } else if actor == 1 {
        assert_eq(auth_key(sk), pair.taker_auth, "not the taker");
    } else {
        assert_eq(auth_key(sk), pair.maker_auth, "not the maker");
        assert_eq(reduce, 0, "only the taker reduces");
    }
    if (remove != 0) | (reduce != 0) {
        assert(mark != 0, "oracle required");
    }

    assert_amount(note.value);
    let spender = owner_tag(auth_key(spender_sk), spender_pk);
    let note_cm = note_commitment(deployment, FREE_DOMAIN, asset, note.value, note_inner(spender, note.rho, note.blind));
    if note.value != 0 {
        assert_eq(merkle_root(note_cm, note.index, note.path), root, "note not in tree");
    }
    assert_eq(owner_nullifier(nullifier_key(spender_sk), note_cm), nf[1]);
    assert(!note.value.lt(add), "note cannot cover the addition");

    let settled = settle_funding(pair, funding_index, scale);
    let taker_pays = settled.taker_pays;

    let fill = if pair.is_short == 0 {
        floor_div(mark * (BPS - pair.close_spread), BPS)
    } else {
        ceil_div(mark * (BPS + pair.close_spread), BPS)
    };
    let realized = pair_pnl(pair.is_short, reduce, pair.entry, fill, scale);
    let netted = if taker_pays == realized.taker_gains { min(realized.floor, settled.unpaid) } else { 0 };
    let unpaid = settled.unpaid - netted;
    let transfer = realized.floor - netted;
    let (loser_margin, gainer_margin) = if realized.taker_gains {
        (settled.maker_margin, settled.taker_margin)
    } else {
        (settled.taker_margin, settled.maker_margin)
    };
    assert(!loser_margin.lt(transfer), "underwater pair cannot reduce");
    let (taker_after, maker_after) = if realized.taker_gains {
        (gainer_margin + transfer, loser_margin - transfer)
    } else {
        (loser_margin - transfer, gainer_margin + transfer)
    };
    let taker_fee = min(fee(reduce, fill, fee_bps, scale), taker_after);

    let mut taker_margin = taker_after - taker_fee;
    let mut maker_margin = maker_after;
    if actor == 1 {
        taker_margin += add;
        assert(!taker_margin.lt(remove), "removal above margin");
        taker_margin -= remove;
    } else if actor == 2 {
        maker_margin += add;
        assert(!maker_margin.lt(remove), "removal above margin");
        maker_margin -= remove;
    }

    let size = pair.size - reduce;
    if remove != 0 {
        let im = margin_requirement(size, mark, imr_wad, scale);
        let health = pair_pnl(pair.is_short, size, pair.entry, mark, scale);
        if actor == 1 {
            let certified = PairPnl { taker_gains: health.taker_gains, floor: min(health.floor, maker_margin), ceil: health.ceil };
            let required = if taker_pays { im + unpaid } else { im };
            assert(!below(taker_margin, health.taker_gains, certified, required), "below initial margin");
        } else {
            let certified = PairPnl { taker_gains: health.taker_gains, floor: min(health.floor, taker_margin), ceil: health.ceil };
            let required = if taker_pays { im } else { im + unpaid };
            assert(!below(maker_margin, !health.taker_gains, certified, required), "below initial margin");
        }
    }

    let next = Pair {
        market,
        asset,
        is_short: pair.is_short,
        size,
        entry: pair.entry,
        funding_index,
        close_spread: pair.close_spread,
        funding_debt: unpaid,
        debt_by_taker: if (unpaid != 0) & taker_pays { 1 } else { 0 },
        last_reduce: reduce,
        taker_margin,
        maker_margin,
        taker_auth: pair.taker_auth,
        taker_x: pair.taker_x,
        taker_y: pair.taker_y,
        maker_auth: pair.maker_auth,
        maker_x: pair.maker_x,
        maker_y: pair.maker_y,
        rec_nonce: rec_nonce(nf[0], nf[1], 0, salt),
        blind: new_blind,
    };
    assert_eq(next.commit(deployment), cm_pair);
    if carried_nf != 0 {
        assert_eq(carried_nf, rec_nullifier(cm_pair, next.rec_nonce), "wrong carried nullifier");
    }
    assert_eq(oi_delta(deployment, market, pair.is_short, reduce, 1, 0, 0, next.rec_nonce), delta_cm);
    let plain = next.plaintext();
    let keys = [
        point(pair.taker_x, pair.taker_y), point(pair.maker_x, pair.maker_y), point(risk_pk[0][0], risk_pk[0][1]),
        point(risk_pk[1][0], risk_pk[1][1]),
    ];
    for i in 0..4 {
        assert_eq(encrypt(plain, keys[i], pair_eph[i]), ct_pair[i]);
    }

    let out_value = note.value - add + remove;
    assert_eq(
        pair.taker_margin + pair.maker_margin + note.value,
        taker_margin + maker_margin + out_value + taker_fee,
        "value not conserved",
    );
    let (out_auth, out_key) = if actor == 2 { (pair.maker_auth, keys[1]) } else { (pair.taker_auth, keys[0]) };
    let out_rho = output_rho(nf[0], nf[1], 1);
    assert_eq(cm_out, note_commitment(deployment, FREE_DOMAIN, asset, out_value, note_inner(owner_tag(out_auth, out_key), out_rho, out_blind)));
    assert_eq(encrypt([FREE_DOMAIN, asset, out_value, out_rho, out_blind], out_key, out_eph), ct_out);

    let fee_key = point(fee_pk[0], fee_pk[1]);
    let fee_rho = output_rho(nf[0], nf[1], 2);
    assert_eq(cm_fee, note_commitment(deployment, FREE_DOMAIN, asset, taker_fee, note_inner(owner_tag(fee_auth, fee_key), fee_rho, fee_blind)));
    assert_eq(encrypt([FREE_DOMAIN, asset, taker_fee, fee_rho, fee_blind], fee_key, fee_eph), ct_fee);
}
