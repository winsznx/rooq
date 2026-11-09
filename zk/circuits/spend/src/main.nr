// Owner-proved spend of up to two FREE notes into three new FREE notes (the third can pay a relayer privately, D-05),
// an optional public withdrawal and an optional public relayer fee (ADR-P02 sections 6 and 8). Produced in the wallet: the spending key never leaves it.
//
// The note asset stays private unless value leaves the shielded pool (withdrawal or relayer fee), in which case
// public_asset must equal it. Ciphertexts are public inputs so the contract publishes exactly what the proof
// encrypted to each recipient (REC-01).
use rooq_zk::{
    assert_address, assert_amount, auth_key, encrypt, FREE_DOMAIN, merkle_root, note_commitment, note_inner,
    NOTE_CT_LEN, nullifier_key, output_rho, owner_nullifier, owner_tag, TREE_DEPTH,
};
use std::embedded_curve_ops::EmbeddedCurvePoint;

struct InputNote {
    value: Field,
    rho: Field,
    blind: Field,
    index: Field,
    path: [Field; TREE_DEPTH],
}

struct OutputNote {
    value: Field,
    recipient_auth: Field,
    recipient_pk: EmbeddedCurvePoint,
    blind: Field,
    eph: Field,
}

fn main(
    sk: Field,
    own_pk: EmbeddedCurvePoint,
    asset: Field,
    ins: [InputNote; 2],
    outs: [OutputNote; 3],
    root: pub Field,
    nf: pub [Field; 2],
    cm_out: pub [Field; 3],
    ct: pub [[Field; NOTE_CT_LEN]; 3],
    deployment: pub Field,
    public_asset: pub Field,
    withdraw_amount: pub Field,
    withdraw_recipient: pub Field,
    relayer: pub Field,
    relayer_fee: pub Field,
) {
    assert_address(asset);
    let owner = owner_tag(auth_key(sk), own_pk);
    let nk = nullifier_key(sk);

    let mut total_in = 0;
    for i in 0..2 {
        let n = ins[i];
        assert_amount(n.value);
        let cm = note_commitment(deployment, FREE_DOMAIN, asset, n.value, note_inner(owner, n.rho, n.blind));
        // A zero-value input is a dummy: it needs no membership but still publishes a unique nullifier.
        if n.value != 0 {
            assert_eq(merkle_root(cm, n.index, n.path), root, "input not in tree");
        }
        assert_eq(owner_nullifier(nk, cm), nf[i]);
        total_in += n.value;
    }
    assert(nf[0] != nf[1], "same note twice");

    let mut total_out = withdraw_amount + relayer_fee;
    assert_amount(withdraw_amount);
    assert_amount(relayer_fee);
    for i in 0..3 {
        let o = outs[i];
        assert_amount(o.value);
        let rho = output_rho(nf[0], nf[1], i as Field);
        let recipient = owner_tag(o.recipient_auth, o.recipient_pk);
        let cm = note_commitment(deployment, FREE_DOMAIN, asset, o.value, note_inner(recipient, rho, o.blind));
        assert_eq(cm, cm_out[i]);
        assert_eq(encrypt([FREE_DOMAIN, asset, o.value, rho, o.blind], o.recipient_pk, o.eph), ct[i]);
        total_out += o.value;
    }
    assert_eq(total_in, total_out, "value not conserved");

    assert_address(withdraw_recipient);
    assert_address(relayer);
    if withdraw_amount + relayer_fee == 0 {
        assert_eq(public_asset, 0, "asset revealed without a public transfer");
    } else {
        assert_eq(public_asset, asset);
    }
}
