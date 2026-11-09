// Closes a whole pair without penalty, paying both owners from the pair's own margins (PERP-03, REC-03..05, D-10, D-11).
//
//   mode 0  Taker close. Needs the taker's key. Fills at the mark less the maker's standing close spread, which the
//           maker committed when it opened the position, so a maker that has disappeared cannot block the exit.
//           Refused if either side cannot pay in full: an underwater pair belongs to liquidation.
//   mode 1  Matured forced exit. No key here: the contract checks the owner-proved request has waited its full delay.
//           Fills at the mark.
//   mode 2  Dead oracle. As mode 1, and the contract checks the oracle has been unavailable past its limit. No price is
//           used at all: the pair settles at its entry price, so nobody picks a stale favorable mark (REC-05).
//
// Mode 0 pays the market fee, capped by what the taker has left, as a shielded note. The other modes pay none.
// Funding settles first and unpaid funding is netted against the payer's gain (D-03). Insurance is never touched, so
// a payout cannot depend on the order pairs are settled in (REC-04): a losing side that cannot pay short-pays its
// counterparty only.
use rooq_zk::{
    auth_key, BPS, ceil_div, encrypt, fee, floor_div, FREE_DOMAIN, merkle_root, min, note_commitment, note_inner, NOTE_CT_LEN,
    oi_delta, output_rho, owner_tag, Pair, pair_pnl, point, PRICE_BITS, rec_nullifier, settle_funding, TREE_DEPTH,
};

fn main(
    pair: Pair,
    index: Field,
    path: [Field; TREE_DEPTH],
    sk: Field,
    blind: [Field; 3],
    eph: [Field; 3],
    root: pub Field,
    nf: pub Field,
    cm_out: pub [Field; 3],
    ct: pub [[Field; NOTE_CT_LEN]; 3],
    deployment: pub Field,
    market: pub Field,
    asset: pub Field,
    mark: pub Field,
    scale: pub Field,
    funding_index: pub Field,
    delta_cm: pub Field,
    mode: pub Field,
    fee_bps: pub Field,
    fee_auth: pub Field,
    fee_pk: pub [Field; 2],
) {
    let cm = pair.commit(deployment);
    assert_eq(merkle_root(cm, index, path), root, "pair not in tree");
    assert_eq(rec_nullifier(cm, pair.rec_nonce), nf);
    assert_eq(pair.market, market, "wrong market");
    assert_eq(pair.asset, asset);
    assert_eq(oi_delta(deployment, market, pair.is_short, pair.size, 1, 0, 0, pair.rec_nonce), delta_cm);
    mark.assert_max_bit_size::<PRICE_BITS>();
    assert(mode * (mode - 1) * (mode - 2) == 0, "unknown mode");

    if mode == 0 {
        assert_eq(auth_key(sk), pair.taker_auth, "not the taker");
    }
    let fill = if mode == 0 {
        if pair.is_short == 0 {
            floor_div(mark * (BPS - pair.close_spread), BPS)
        } else {
            ceil_div(mark * (BPS + pair.close_spread), BPS)
        }
    } else if mode == 1 {
        mark
    } else {
        pair.entry
    };

    let settled = settle_funding(pair, funding_index, scale);
    let pnl = pair_pnl(pair.is_short, pair.size, pair.entry, fill, scale);
    let netted = if settled.taker_pays == pnl.taker_gains { min(pnl.floor, settled.unpaid) } else { 0 };
    let transfer = pnl.floor - netted;
    let (loser_margin, gainer_margin) = if pnl.taker_gains {
        (settled.maker_margin, settled.taker_margin)
    } else {
        (settled.taker_margin, settled.maker_margin)
    };
    let paid = min(transfer, loser_margin);
    if mode == 0 {
        assert_eq(paid, transfer, "underwater pair cannot close");
    }
    let (taker_after, maker_left) = if pnl.taker_gains {
        (gainer_margin + paid, loser_margin - paid)
    } else {
        (loser_margin - paid, gainer_margin + paid)
    };
    let taker_fee = if mode == 0 { min(fee(pair.size, fill, fee_bps, scale), taker_after) } else { 0 };
    let taker_left = taker_after - taker_fee;
    assert_eq(pair.taker_margin + pair.maker_margin, taker_left + maker_left + taker_fee, "value not conserved");

    let outs = [
        (taker_left, pair.taker_auth, point(pair.taker_x, pair.taker_y)),
        (maker_left, pair.maker_auth, point(pair.maker_x, pair.maker_y)),
        (taker_fee, fee_auth, point(fee_pk[0], fee_pk[1])),
    ];
    for i in 0..3 {
        let (value, auth, pk) = outs[i];
        let rho = output_rho(nf, 0, i as Field);
        assert_eq(cm_out[i], note_commitment(deployment, FREE_DOMAIN, asset, value, note_inner(owner_tag(auth, pk), rho, blind[i])));
        assert_eq(encrypt([FREE_DOMAIN, asset, value, rho, blind[i]], pk, eph[i]), ct[i]);
    }
}
