// Pays a CLAIM as a FREE note, at the ratio of the epoch that folded its market-state change (D-07). The contract supplies
// the ratio and refuses a claim that has not been folded. Needs no key: the only possible beneficiary is the committed owner.
//
// The relay fee note (rho index 1) comes out of the payout. A nonzero fee needs the claim owner's key, so a prover holding
// only the plaintext can't pay itself from the claim; it can still redeem with a zero fee.
use rooq_zk::{
    auth_key, Claim, encrypt, floor_div, FREE_DOMAIN, merkle_root, note_commitment, note_inner, NOTE_CT_LEN, output_rho,
    owner_tag, point, rec_nullifier, relay_fee_note, RelayFee, TREE_DEPTH, WAD,
};

mod tests;

fn main(
    claim: Claim,
    index: Field,
    path: [Field; TREE_DEPTH],
    blind: Field,
    eph: Field,
    sk: Field,
    relay: RelayFee,
    root: pub Field,
    nf: pub Field,
    cm_out: pub Field,
    ct: pub [Field; NOTE_CT_LEN],
    deployment: pub Field,
    delta_cm: pub Field,
    ratio: pub Field,
    cm_relay: pub Field,
    ct_relay: pub [Field; NOTE_CT_LEN],
) {
    let cm = claim.commit(deployment);
    assert_eq(merkle_root(cm, index, path), root, "claim not in tree");
    assert_eq(rec_nullifier(cm, claim.rec_nonce), nf);
    assert_eq(claim.delta_cm, delta_cm, "wrong market change");
    assert(!WAD.lt(ratio), "ratio above one");
    let paid = floor_div(claim.amount * ratio, WAD);

    relay_fee_note(deployment, claim.asset, relay, nf, 0, 1, cm_relay, ct_relay);
    if relay.value != 0 {
        assert_eq(auth_key(sk), claim.owner_auth, "fee needs the owner key");
    }
    assert(!paid.lt(relay.value), "fee above available");
    let value = paid - relay.value;

    let key = point(claim.owner_x, claim.owner_y);
    let rho = output_rho(nf, 0, 0);
    assert_eq(cm_out, note_commitment(deployment, FREE_DOMAIN, claim.asset, value, note_inner(owner_tag(claim.owner_auth, key), rho, blind)));
    assert_eq(encrypt([FREE_DOMAIN, claim.asset, value, rho, blind], key, eph), ct);
}
