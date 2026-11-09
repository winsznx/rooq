// Moves a wound-down market's insurance to the fee address as a shielded note (D-17). The contract allows this only when
// no market-state change is pending and the oracle has been dead past its long limit; this proof shows no position is open.
use rooq_zk::{
    assert_amount, encrypt, FREE_DOMAIN, market_head, MARKET_CT_LEN, note_commitment, note_inner, NOTE_CT_LEN, output_rho, owner_tag,
    point,
};

fn main(
    insurance: Field,
    bad_debt: Field,
    bond_used: Field,
    blind: Field,
    new_blind: Field,
    out_blind: Field,
    out_eph: Field,
    eph: [Field; 3],
    deployment: pub Field,
    market: pub Field,
    asset: pub Field,
    head: pub Field,
    new_head: pub Field,
    cm_out: pub Field,
    ct_out: pub [Field; NOTE_CT_LEN],
    fee_auth: pub Field,
    fee_pk: pub [Field; 2],
    keys: pub [[Field; 2]; 3],
    ct: pub [[Field; MARKET_CT_LEN]; 3],
) {
    assert_eq(market_head(deployment, market, 0, 0, insurance, bad_debt, bond_used, blind), head, "open positions or wrong record");
    assert_amount(insurance);
    assert_eq(market_head(deployment, market, 0, 0, 0, bad_debt, bond_used, new_blind), new_head);
    let fee_key = point(fee_pk[0], fee_pk[1]);
    let rho = output_rho(head, new_head, 0);
    assert_eq(cm_out, note_commitment(deployment, FREE_DOMAIN, asset, insurance, note_inner(owner_tag(fee_auth, fee_key), rho, out_blind)));
    assert_eq(encrypt([FREE_DOMAIN, asset, insurance, rho, out_blind], fee_key, out_eph), ct_out);
    for i in 0..3 {
        assert_eq(encrypt([0, 0, 0, bad_debt, bond_used, new_blind], point(keys[i][0], keys[i][1]), eph[i]), ct[i]);
    }
}
