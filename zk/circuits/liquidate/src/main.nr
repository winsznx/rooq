// Forced full-pair liquidation (LIQ-01..03), proved by a risk worker from the pair plaintext it decrypted with its
// own risk key. No owner key, signature or fresh client proof is involved.
//
// Statement: the PAIR is in the tree and unspent (shared nullifier, so this and any other branch cannot both
// consume it). Funding since the pair's snapshot settles first against the contract's index: the payer pays what
// its margin covers and the unpaid amount counts against its health and against its own PnL gain (D-03). At the
// contract-supplied fresh mark and the market's maintenance fraction, the taker (checked first, as
// ClearingHouse.liquidate does) or else the maker is below maintenance. The pair closes at the mark with the PnL
// transfer capped by the loser's margin. The liquidated side pays the penalty, capped by what it has left: half to the
// liquidator as a shielded note, half to insurance. Remaining balances go to the owners committed in the pair as
// FREE notes, encrypted to their keys.
//
// No insurance amount is public (D-07). The penalty share and any shortfall go into a hidden market-state change, and the
// winner receives a CLAIM record, created in every liquidation so its presence reveals nothing. funding_epoch folds the
// change and fixes the pro-rata ratio that pays the claim.
use rooq_zk::{
    assert_amount, below, encrypt, fee, FREE_DOMAIN, margin_requirement, merkle_root, min, note_commitment, note_inner,
    NOTE_CT_LEN, oi_delta, output_rho, owner_tag, Pair, pair_pnl, point, PRICE_BITS, rec_nonce, rec_nullifier, settle_funding,
    TREE_DEPTH, Claim, CLAIM_CT_LEN,
};
use std::embedded_curve_ops::EmbeddedCurvePoint;

fn main(
    pair: Pair,
    index: Field,
    path: [Field; TREE_DEPTH],
    liquidator_auth: Field,
    liquidator_pk: EmbeddedCurvePoint,
    blind: [Field; 3],
    eph: [Field; 3],
    to_insurance: Field,
    claim_salt: Field,
    claim_blind: Field,
    claim_eph: [Field; 3],
    root: pub Field,
    nf: pub Field,
    cm_out: pub [Field; 3],
    ct: pub [[Field; NOTE_CT_LEN]; 3],
    deployment: pub Field,
    market: pub Field,
    asset: pub Field,
    mark: pub Field,
    mmr_wad: pub Field,
    penalty_bps: pub Field,
    scale: pub Field,
    funding_index: pub Field,
    delta_cm: pub Field,
    cm_claim: pub Field,
    ct_claim: pub [[Field; CLAIM_CT_LEN]; 3],
    risk_pk: pub [[Field; 2]; 2],
) {
    let cm = pair.commit(deployment);
    assert_eq(merkle_root(cm, index, path), root, "pair not in tree");
    assert_eq(rec_nullifier(cm, pair.rec_nonce), nf);
    assert_eq(pair.market, market, "wrong market");
    assert_eq(pair.asset, asset);
    mark.assert_max_bit_size::<PRICE_BITS>();

    let settled = settle_funding(pair, funding_index, scale);
    let (taker_pays, taker_margin, maker_margin, unpaid) =
        (settled.taker_pays, settled.taker_margin, settled.maker_margin, settled.unpaid);

    let mm = margin_requirement(pair.size, mark, mmr_wad, scale);
    let pnl = pair_pnl(pair.is_short, pair.size, pair.entry, mark, scale);
    let taker_required = if taker_pays { mm + unpaid } else { mm };
    let maker_required = if taker_pays { mm } else { mm + unpaid };
    let taker_bad = below(taker_margin, pnl.taker_gains, pnl, taker_required);
    let maker_bad = below(maker_margin, !pnl.taker_gains, pnl, maker_required);
    assert(taker_bad | maker_bad, "pair is healthy");

    // D-03: unpaid funding comes out of the payer's own gain before any of it is transferred.
    let netted = if taker_pays == pnl.taker_gains { min(pnl.floor, unpaid) } else { 0 };
    let transfer = pnl.floor - netted;

    let (loser_margin, gainer_margin) = if pnl.taker_gains {
        (maker_margin, taker_margin)
    } else {
        (taker_margin, maker_margin)
    };
    let paid = min(transfer, loser_margin);
    let shortfall = transfer - paid;
    let loser_left = loser_margin - paid;
    let gainer_left = gainer_margin + paid;
    let (mut taker_left, mut maker_left) = if pnl.taker_gains {
        (gainer_left, loser_left)
    } else {
        (loser_left, gainer_left)
    };

    let base = fee(pair.size, mark, penalty_bps, scale);
    let penalty = if taker_bad {
        let p = min(base, taker_left);
        taker_left -= p;
        p
    } else {
        let p = min(base, maker_left);
        maker_left -= p;
        p
    };
    let reward = penalty - to_insurance;
    // reward = floor(penalty / 2). The range check matters: without it, an odd penalty also admits
    // reward = penalty / 2 mod p, a value no real note could hold.
    assert_amount(reward);
    let odd = penalty - 2 * reward;
    assert(odd * (odd - 1) == 0, "reward is half the penalty");
    assert_eq(
        pair.taker_margin + pair.maker_margin,
        taker_left + maker_left + reward + to_insurance,
        "value not conserved",
    );

    let outs = [
        (taker_left, pair.taker_auth, point(pair.taker_x, pair.taker_y)),
        (maker_left, pair.maker_auth, point(pair.maker_x, pair.maker_y)),
        (reward, liquidator_auth, liquidator_pk),
    ];
    for i in 0..3 {
        let (value, auth, pk) = outs[i];
        let rho = output_rho(nf, 0, i as Field);
        let owner = owner_tag(auth, pk);
        assert_eq(cm_out[i], note_commitment(deployment, FREE_DOMAIN, asset, value, note_inner(owner, rho, blind[i])));
        assert_eq(encrypt([FREE_DOMAIN, asset, value, rho, blind[i]], pk, eph[i]), ct[i]);
    }

    assert_eq(oi_delta(deployment, market, pair.is_short, pair.size, 1, to_insurance, shortfall, pair.rec_nonce), delta_cm);
    let (winner_auth, winner_x, winner_y) = if pnl.taker_gains {
        (pair.taker_auth, pair.taker_x, pair.taker_y)
    } else {
        (pair.maker_auth, pair.maker_x, pair.maker_y)
    };
    let claim = Claim {
        market,
        asset,
        amount: shortfall,
        owner_auth: winner_auth,
        owner_x: winner_x,
        owner_y: winner_y,
        ins_in: to_insurance,
        pair_nonce: pair.rec_nonce,
        delta_cm,
        rec_nonce: rec_nonce(nf, 0, 3, claim_salt),
        blind: claim_blind,
    };
    assert_eq(claim.commit(deployment), cm_claim);
    let claim_keys = [point(winner_x, winner_y), point(risk_pk[0][0], risk_pk[0][1]), point(risk_pk[1][0], risk_pk[1][1])];
    let plain = claim.plaintext();
    for i in 0..3 {
        assert_eq(encrypt(plain, claim_keys[i], claim_eph[i]), ct_claim[i]);
    }
}
