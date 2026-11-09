// Op A: private 2-in 2-out transfer (zk/bench/STATEMENT.md).
use rooq_bench::{
    put, put_at, put_at2,
    assert_amount, encrypt_hash, enc_pubkey, h, merkle_root, Note, owner_tag, T_AUTH, T_NF, T_NK,
    TREE_DEPTH,
};
use std::embedded_curve_ops::EmbeddedCurvePoint;

struct Output {
    value: Field,
    recipient_auth: Field,
    recipient_pk: EmbeddedCurvePoint,
    rho: Field,
    blind: Field,
    eph: Field,
}

fn main(
    sk: Field,
    enc_sk: Field,
    in_values: [Field; 2],
    in_rho: [Field; 2],
    in_blind: [Field; 2],
    in_index: [Field; 2],
    in_path: [[Field; TREE_DEPTH]; 2],
    outs: [Output; 2],
    root: pub Field,
    nf: pub [Field; 2],
    cm_out: pub [Field; 2],
    ct_hash: pub [Field; 2],
    deployment: pub Field,
    domain: pub Field,
    asset: pub Field,
    fee: pub Field,
) {
    let auth = h([T_AUTH, sk]);
    let nk = h([T_NK, sk]);
    let owner = owner_tag(auth, enc_pubkey(enc_sk));

    let mut total_in = 0;
    for i in 0..2 {
        assert_amount(in_values[i]);
        let note = Note { domain, asset, value: in_values[i], owner, rho: in_rho[i], blind: in_blind[i] };
        let cm = note.commit(deployment);
        assert_eq(merkle_root(cm, in_index[i], in_path[i]), root);
        assert_eq(h([T_NF, nk, cm]), nf[i]);
        total_in += in_values[i];
    }
    assert(nf[0] != nf[1]);

    let mut total_out = fee;
    assert_amount(fee);
    for i in 0..2 {
        let o = outs[i];
        assert_amount(o.value);
        let out_owner = owner_tag(o.recipient_auth, o.recipient_pk);
        let note = Note { domain, asset, value: o.value, owner: out_owner, rho: o.rho, blind: o.blind };
        assert_eq(note.commit(deployment), cm_out[i]);
        let pt = [domain, asset, o.value, o.rho, o.blind];
        assert_eq(encrypt_hash(pt, o.recipient_pk, o.eph), ct_hash[i]);
        total_out += o.value;
    }
    assert_eq(total_in, total_out);
}

#[test]
fn gen_prover_toml() {
    let deployment = 46630;
    let domain = 0;
    let asset = 0x7e955252e15c84f5768b83c41a71f9eba181802f;
    let fee = 1_000;
    let sk = 0x1234;
    let enc_sk = 0x5678;
    let owner = owner_tag(h([T_AUTH, sk]), enc_pubkey(enc_sk));
    let nk = h([T_NK, sk]);
    let in_values = [600_000, 400_000];
    let in_rho = [11, 12];
    let in_blind = [21, 22];
    let cm0 = Note { domain, asset, value: in_values[0], owner, rho: in_rho[0], blind: in_blind[0] }.commit(deployment);
    let cm1 = Note { domain, asset, value: in_values[1], owner, rho: in_rho[1], blind: in_blind[1] }.commit(deployment);
    let path0 = rooq_bench::filler_path(cm1);
    let path1 = rooq_bench::filler_path(cm0);
    let root = merkle_root(cm0, 0, path0);
    assert_eq(root, merkle_root(cm1, 1, path1));
    let recipient_pk = enc_pubkey(0x9abc);
    let recipient_auth = h([T_AUTH, 0xdef0]);
    let own_pk = enc_pubkey(enc_sk);
    let own_auth = h([T_AUTH, sk]);
    let outs = [
        Output { value: 700_000, recipient_auth, recipient_pk, rho: 31, blind: 41, eph: 51 },
        Output { value: 299_000, recipient_auth: own_auth, recipient_pk: own_pk, rho: 32, blind: 42, eph: 52 },
    ];
    let mut cm_out = [0; 2];
    let mut ct = [0; 2];
    for i in 0..2 {
        let o = outs[i];
        cm_out[i] = Note { domain, asset, value: o.value, owner: owner_tag(o.recipient_auth, o.recipient_pk), rho: o.rho, blind: o.blind }.commit(deployment);
        ct[i] = encrypt_hash([domain, asset, o.value, o.rho, o.blind], o.recipient_pk, o.eph);
    }
    let nf = [h([T_NF, nk, cm0]), h([T_NF, nk, cm1])];
    put("sk", sk);
    put("enc_sk", enc_sk);
    put("root", root);
    put("deployment", deployment);
    put("domain", domain);
    put("asset", asset);
    put("fee", fee);
    for i in 0..2 {
        put_at("in_values", i, in_values[i]);
        put_at("in_rho", i, in_rho[i]);
        put_at("in_blind", i, in_blind[i]);
        put_at("in_index", i, i as Field);
        put_at("nf", i, nf[i]);
        put_at("cm_out", i, cm_out[i]);
        put_at("ct_hash", i, ct[i]);
        let o = outs[i];
        put_at("outs[].value", i, o.value);
        put_at("outs[].recipient_auth", i, o.recipient_auth);
        put_at("outs[].recipient_pk.x", i, o.recipient_pk.x);
        put_at("outs[].recipient_pk.y", i, o.recipient_pk.y);
        put_at("outs[].rho", i, o.rho);
        put_at("outs[].blind", i, o.blind);
        put_at("outs[].eph", i, o.eph);
    }
    for j in 0..TREE_DEPTH {
        put_at2("in_path", 0, j, path0[j]);
        put_at2("in_path", 1, j, path1[j]);
    }
}

#[test]
fn gen_prover_toml_b() {
    let deployment = 46630;
    let domain = 0;
    let asset = 0x7e955252e15c84f5768b83c41a71f9eba181802f;
    let fee = 1_000;
    let sk = 0x1234;
    let enc_sk = 0x5678;
    let owner = owner_tag(h([T_AUTH, sk]), enc_pubkey(enc_sk));
    let nk = h([T_NK, sk]);
    let in_values = [600_000, 400_000];
    let in_rho = [111, 112];
    let in_blind = [21, 22];
    let cm0 = Note { domain, asset, value: in_values[0], owner, rho: in_rho[0], blind: in_blind[0] }.commit(deployment);
    let cm1 = Note { domain, asset, value: in_values[1], owner, rho: in_rho[1], blind: in_blind[1] }.commit(deployment);
    let path0 = rooq_bench::filler_path(cm1);
    let path1 = rooq_bench::filler_path(cm0);
    let root = merkle_root(cm0, 0, path0);
    assert_eq(root, merkle_root(cm1, 1, path1));
    let recipient_pk = enc_pubkey(0x9abc);
    let recipient_auth = h([T_AUTH, 0xdef0]);
    let own_pk = enc_pubkey(enc_sk);
    let own_auth = h([T_AUTH, sk]);
    let outs = [
        Output { value: 700_000, recipient_auth, recipient_pk, rho: 31, blind: 41, eph: 51 },
        Output { value: 299_000, recipient_auth: own_auth, recipient_pk: own_pk, rho: 32, blind: 42, eph: 52 },
    ];
    let mut cm_out = [0; 2];
    let mut ct = [0; 2];
    for i in 0..2 {
        let o = outs[i];
        cm_out[i] = Note { domain, asset, value: o.value, owner: owner_tag(o.recipient_auth, o.recipient_pk), rho: o.rho, blind: o.blind }.commit(deployment);
        ct[i] = encrypt_hash([domain, asset, o.value, o.rho, o.blind], o.recipient_pk, o.eph);
    }
    let nf = [h([T_NF, nk, cm0]), h([T_NF, nk, cm1])];
    put("sk", sk);
    put("enc_sk", enc_sk);
    put("root", root);
    put("deployment", deployment);
    put("domain", domain);
    put("asset", asset);
    put("fee", fee);
    for i in 0..2 {
        put_at("in_values", i, in_values[i]);
        put_at("in_rho", i, in_rho[i]);
        put_at("in_blind", i, in_blind[i]);
        put_at("in_index", i, i as Field);
        put_at("nf", i, nf[i]);
        put_at("cm_out", i, cm_out[i]);
        put_at("ct_hash", i, ct[i]);
        let o = outs[i];
        put_at("outs[].value", i, o.value);
        put_at("outs[].recipient_auth", i, o.recipient_auth);
        put_at("outs[].recipient_pk.x", i, o.recipient_pk.x);
        put_at("outs[].recipient_pk.y", i, o.recipient_pk.y);
        put_at("outs[].rho", i, o.rho);
        put_at("outs[].blind", i, o.blind);
        put_at("outs[].eph", i, o.eph);
    }
    for j in 0..TREE_DEPTH {
        put_at2("in_path", 0, j, path0[j]);
        put_at2("in_path", 1, j, path1[j]);
    }
}
