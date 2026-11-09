// Op B: private perp open against a maker-signed RFQ quote (zk/bench/STATEMENT.md).
use rooq_bench::{
    put, put_at,
    assert_amount, assert_le, bytes32, ceil_div, keccak, encrypt_hash, enc_pubkey, h, merkle_root, Note,
    owner_tag, T_AUTH, T_MAKER, T_NF, T_NF_REC, T_NK, T_ORACLE, T_PAIR, T_QUOTE, T_TAKER, TREE_DEPTH,
};
use std::embedded_curve_ops::EmbeddedCurvePoint;

global FREE_DOMAIN: Field = 0;
global FEE_DOMAIN: Field = 2;
global E30: Field = 1_000_000_000_000_000_000_000_000_000_000;
// keccak256("Quote(bytes32 marketId,address maker,bytes32 taker,int256 size,uint256 price,uint256 minFill,uint256 nonce,uint64 deadline,uint32 policyVersion)")
global QUOTE_TYPEHASH: [u8; 32] = [3, 13, 188, 78, 110, 201, 53, 60, 110, 252, 4, 192, 248, 126, 200, 150, 179, 78, 214, 204, 147, 7, 176, 30, 36, 86, 14, 50, 151, 78, 137, 81];

struct Quote {
    maker: Field,
    size_abs: Field,
    is_long: bool,
    price: Field,
    min_fill: Field,
    nonce: Field,
    deadline: Field,
}

struct MakerAuth {
    pub_x: [u8; 32],
    pub_y: [u8; 32],
    signature: [u8; 64],
}

struct Witness {
    sk: Field,
    enc_sk: Field,
    taker_value: Field,
    taker_rho: Field,
    taker_blind: Field,
    taker_index: Field,
    taker_path: [Field; TREE_DEPTH],
    maker_value: Field,
    maker_rho: Field,
    maker_blind: Field,
    maker_rec_nonce: Field,
    maker_index: Field,
    maker_path: [Field; TREE_DEPTH],
    oracle_price: Field,
    oracle_epoch: Field,
    taker_margin: Field,
    maker_margin: Field,
    funding_snapshot: Field,
    pair_nonce: Field,
    pair_blind: Field,
    change_rho: Field,
    change_blind: Field,
    maker_change_rho: Field,
    maker_change_blind: Field,
    fee_rho: Field,
    fee_blind: Field,
    eph_risk: Field,
    eph_owner: Field,
}

fn signed_word(abs: Field, is_long: bool) -> [u8; 32] {
    let b = bytes32(abs);
    if is_long {
        b
    } else {
        // Two's complement negation of a 256-bit word: invert and add one.
        let mut out = [0; 32];
        let mut carry: u16 = 1;
        for k in 0..32 {
            let i = 31 - k;
            let v = (255 - b[i]) as u16 + carry;
            out[i] = v as u8;
            carry = v >> 8;
        }
        out
    }
}

fn quote_digest(domain_separator: Field, market: Field, taker: Field, policy: Field, q: Quote) -> [u8; 32] {
    let words = [
        QUOTE_TYPEHASH, bytes32(market), bytes32(q.maker), bytes32(taker),
        signed_word(q.size_abs, q.is_long), bytes32(q.price), bytes32(q.min_fill), bytes32(q.nonce),
        bytes32(q.deadline), bytes32(policy),
    ];
    let mut buf = [0; 320];
    for w in 0..10 {
        for i in 0..32 {
            buf[w * 32 + i] = words[w][i];
        }
    }
    let struct_hash = keccak(buf);
    let mut msg = [0; 66];
    msg[0] = 0x19;
    msg[1] = 0x01;
    let ds = bytes32(domain_separator);
    for i in 0..32 {
        msg[2 + i] = ds[i];
        msg[34 + i] = struct_hash[i];
    }
    keccak(msg)
}

fn eth_address(m: MakerAuth) -> Field {
    let mut pk = [0; 64];
    for i in 0..32 {
        pk[i] = m.pub_x[i];
        pk[32 + i] = m.pub_y[i];
    }
    let hashed = keccak(pk);
    let mut addr: Field = 0;
    for i in 12..32 {
        addr = addr * 256 + hashed[i] as Field;
    }
    addr
}

fn main(
    w: Witness,
    q: Quote,
    m: MakerAuth,
    root: pub Field,
    nf_taker: pub Field,
    nf_maker: pub Field,
    quote_id: pub Field,
    cm_pair: pub Field,
    cm_taker_change: pub Field,
    cm_maker_change: pub Field,
    cm_fee: pub Field,
    ct_pair_risk: pub Field,
    ct_pair_owner: pub Field,
    oracle_cm: pub Field,
    batch_time: pub Field,
    domain_separator: pub Field,
    deployment: pub Field,
    policy_version: pub Field,
    risk_pk: pub EmbeddedCurvePoint,
    market: pub Field,
    collateral: pub Field,
    imr_bps: pub Field,
    fee_bps: pub Field,
    max_dev_bps: pub Field,
) {
    // Taker free note, owner branch.
    let auth = h([T_AUTH, w.sk]);
    let nk = h([T_NK, w.sk]);
    let taker_pk = enc_pubkey(w.enc_sk);
    let taker_owner = owner_tag(auth, taker_pk);
    assert_amount(w.taker_value);
    let taker_note = Note {
        domain: FREE_DOMAIN, asset: collateral, value: w.taker_value, owner: taker_owner, rho: w.taker_rho,
        blind: w.taker_blind,
    };
    let taker_cm = taker_note.commit(deployment);
    assert_eq(merkle_root(taker_cm, w.taker_index, w.taker_path), root);
    assert_eq(h([T_NF, nk, taker_cm]), nf_taker);

    // Maker signature over the full quote, bound to chain, contract, market, taker and policy.
    let taker_binding = h([T_TAKER, taker_owner]);
    let digest = quote_digest(domain_separator, market, taker_binding, policy_version, q);
    assert(std::ecdsa_secp256k1::verify_signature(m.pub_x, m.pub_y, m.signature, digest));
    assert_eq(eth_address(m), q.maker);
    q.deadline.assert_max_bit_size::<64>();
    assert_le(batch_time, q.deadline);
    assert_eq(h([T_QUOTE, q.maker, q.nonce]), quote_id);

    // Maker backing record, consumed with the shared-record nullifier (no owner secret).
    let maker_owner = h([T_MAKER, q.maker]);
    assert_amount(w.maker_value);
    let maker_note = Note {
        domain: market, asset: collateral, value: w.maker_value, owner: maker_owner, rho: w.maker_rho,
        blind: w.maker_blind,
    };
    let maker_cm = maker_note.commit(deployment);
    assert_eq(merkle_root(maker_cm, w.maker_index, w.maker_path), root);
    assert_eq(h([T_NF_REC, maker_cm, w.maker_rec_nonce]), nf_maker);

    // Oracle binding and price deviation.
    assert_eq(h([T_ORACLE, market, w.oracle_price, w.oracle_epoch]), oracle_cm);
    assert_amount(w.oracle_price);
    assert_amount(q.price);
    assert_amount(q.size_abs);
    assert(q.size_abs != 0);
    let diff = if q.price.lt(w.oracle_price) { w.oracle_price - q.price } else { q.price - w.oracle_price };
    assert_le(diff * 10_000, max_dev_bps * w.oracle_price);

    // Economics: both sides meet initial margin after the fill; fee is charged on top of taker margin.
    let notional = ceil_div(q.size_abs * q.price, E30);
    let fee = ceil_div(notional * fee_bps, 10_000);
    assert_amount(w.taker_margin);
    assert_amount(w.maker_margin);
    assert_le(notional * imr_bps, w.taker_margin * 10_000);
    assert_le(notional * imr_bps, w.maker_margin * 10_000);
    let taker_spent = w.taker_margin + fee;
    assert_le(taker_spent, w.taker_value);
    assert_le(w.maker_margin, w.maker_value);
    let taker_change = w.taker_value - taker_spent;
    let maker_change = w.maker_value - w.maker_margin;

    // Outputs.
    let pair_pt = [
        market, q.size_abs, q.is_long as Field, q.price, w.taker_margin, w.maker_margin,
        w.funding_snapshot, taker_owner, maker_owner, w.pair_nonce, w.pair_blind,
    ];
    let mut pair_in = [0; 13];
    pair_in[0] = T_PAIR;
    pair_in[1] = deployment;
    for i in 0..11 {
        pair_in[i + 2] = pair_pt[i];
    }
    assert_eq(h(pair_in), cm_pair);
    assert_eq(encrypt_hash(pair_pt, risk_pk, w.eph_risk), ct_pair_risk);
    assert_eq(encrypt_hash(pair_pt, taker_pk, w.eph_owner), ct_pair_owner);

    let change = Note {
        domain: FREE_DOMAIN, asset: collateral, value: taker_change, owner: taker_owner, rho: w.change_rho,
        blind: w.change_blind,
    };
    assert_eq(change.commit(deployment), cm_taker_change);
    let maker_rest = Note {
        domain: market, asset: collateral, value: maker_change, owner: maker_owner, rho: w.maker_change_rho,
        blind: w.maker_change_blind,
    };
    assert_eq(maker_rest.commit(deployment), cm_maker_change);
    let fee_note = Note {
        domain: FEE_DOMAIN, asset: collateral, value: fee, owner: market, rho: w.fee_rho, blind: w.fee_blind,
    };
    assert_eq(fee_note.commit(deployment), cm_fee);
}

#[test]
fn gen_prover_toml() {
    let deployment = 46630;
    let collateral = 0x7e955252e15c84f5768b83c41a71f9eba181802f;
    let market = 0x5453_4c41; // "TSLA"
    let domain_separator = 0x0badc0de;
    let policy_version = 1;
    let batch_time = 1_800_000_000;
    let imr_bps = 1_000;
    let fee_bps = 10;
    let max_dev_bps = 100;
    let maker_addr = 0x70997970c51812dc3a010c7d01b50e0d17dc79c8; // anvil account 1
    let risk_pk = enc_pubkey(0x7777);

    let sk = 0x1234;
    let enc_sk = 0x5678;
    let taker_owner = owner_tag(h([T_AUTH, sk]), enc_pubkey(enc_sk));
    let maker_owner = h([T_MAKER, maker_addr]);
    let q = Quote {
        maker: maker_addr, size_abs: 10_000_000_000_000_000_000, is_long: true,
        price: 400_000_000_000_000_000_000, min_fill: 0, nonce: 7, deadline: batch_time + 30,
    };
    let w = Witness {
        sk, enc_sk, taker_value: 1_000_000_000, taker_rho: 11, taker_blind: 21, taker_index: 0,
        taker_path: [0; TREE_DEPTH], maker_value: 5_000_000_000, maker_rho: 12, maker_blind: 22,
        maker_rec_nonce: 33, maker_index: 1, maker_path: [0; TREE_DEPTH],
        oracle_price: 401_000_000_000_000_000_000, oracle_epoch: 900, taker_margin: 500_000_000,
        maker_margin: 500_000_000, funding_snapshot: 0, pair_nonce: 44, pair_blind: 45, change_rho: 46,
        change_blind: 47, maker_change_rho: 48, maker_change_blind: 49, fee_rho: 50, fee_blind: 51,
        eph_risk: 52, eph_owner: 53,
    };
    let taker_cm = Note { domain: FREE_DOMAIN, asset: collateral, value: w.taker_value, owner: taker_owner, rho: w.taker_rho, blind: w.taker_blind }.commit(deployment);
    let maker_cm = Note { domain: market, asset: collateral, value: w.maker_value, owner: maker_owner, rho: w.maker_rho, blind: w.maker_blind }.commit(deployment);
    let taker_path = rooq_bench::filler_path(maker_cm);
    let maker_path = rooq_bench::filler_path(taker_cm);
    let root = merkle_root(taker_cm, 0, taker_path);

    let notional = 4_000_000_000;
    let fee = 4_000_000;
    let pair_pt = [market, q.size_abs, 1, q.price, w.taker_margin, w.maker_margin, w.funding_snapshot, taker_owner, maker_owner, w.pair_nonce, w.pair_blind];
    let mut pair_in = [0; 13];
    pair_in[0] = T_PAIR;
    pair_in[1] = deployment;
    for i in 0..11 {
        pair_in[i + 2] = pair_pt[i];
    }
    assert_eq(ceil_div(q.size_abs * q.price, E30), notional);
    let digest = quote_digest(domain_separator, market, h([T_TAKER, taker_owner]), policy_version, q);

    put("root", root);
    put("nf_taker", h([T_NF, h([T_NK, sk]), taker_cm]));
    put("nf_maker", h([T_NF_REC, maker_cm, w.maker_rec_nonce]));
    put("quote_id", h([T_QUOTE, q.maker, q.nonce]));
    put("cm_pair", h(pair_in));
    put("cm_taker_change", Note { domain: FREE_DOMAIN, asset: collateral, value: w.taker_value - w.taker_margin - fee, owner: taker_owner, rho: w.change_rho, blind: w.change_blind }.commit(deployment));
    put("cm_maker_change", Note { domain: market, asset: collateral, value: w.maker_value - w.maker_margin, owner: maker_owner, rho: w.maker_change_rho, blind: w.maker_change_blind }.commit(deployment));
    put("cm_fee", Note { domain: FEE_DOMAIN, asset: collateral, value: fee, owner: market, rho: w.fee_rho, blind: w.fee_blind }.commit(deployment));
    put("ct_pair_risk", encrypt_hash(pair_pt, risk_pk, w.eph_risk));
    put("ct_pair_owner", encrypt_hash(pair_pt, enc_pubkey(enc_sk), w.eph_owner));
    put("oracle_cm", h([T_ORACLE, market, w.oracle_price, w.oracle_epoch]));
    put("batch_time", batch_time);
    put("domain_separator", domain_separator);
    put("deployment", deployment);
    put("policy_version", policy_version);
    put("risk_pk.x", risk_pk.x);
    put("risk_pk.y", risk_pk.y);
    put("market", market);
    put("collateral", collateral);
    put("imr_bps", imr_bps);
    put("fee_bps", fee_bps);
    put("max_dev_bps", max_dev_bps);
    put("q.maker", q.maker);
    put("q.size_abs", q.size_abs);
    put("q.is_long", 1);
    put("q.price", q.price);
    put("q.min_fill", q.min_fill);
    put("q.nonce", q.nonce);
    put("q.deadline", q.deadline);
    put("w.sk", w.sk);
    put("w.enc_sk", w.enc_sk);
    put("w.taker_value", w.taker_value);
    put("w.taker_rho", w.taker_rho);
    put("w.taker_blind", w.taker_blind);
    put("w.taker_index", w.taker_index);
    put("w.maker_value", w.maker_value);
    put("w.maker_rho", w.maker_rho);
    put("w.maker_blind", w.maker_blind);
    put("w.maker_rec_nonce", w.maker_rec_nonce);
    put("w.maker_index", w.maker_index);
    put("w.oracle_price", w.oracle_price);
    put("w.oracle_epoch", w.oracle_epoch);
    put("w.taker_margin", w.taker_margin);
    put("w.maker_margin", w.maker_margin);
    put("w.funding_snapshot", w.funding_snapshot);
    put("w.pair_nonce", w.pair_nonce);
    put("w.pair_blind", w.pair_blind);
    put("w.change_rho", w.change_rho);
    put("w.change_blind", w.change_blind);
    put("w.maker_change_rho", w.maker_change_rho);
    put("w.maker_change_blind", w.maker_change_blind);
    put("w.fee_rho", w.fee_rho);
    put("w.fee_blind", w.fee_blind);
    put("w.eph_risk", w.eph_risk);
    put("w.eph_owner", w.eph_owner);
    for j in 0..TREE_DEPTH {
        put_at("w.taker_path", j, taker_path[j]);
        put_at("w.maker_path", j, maker_path[j]);
    }
    put("dbg_taker", h([T_TAKER, taker_owner]));
    for i in 0..32 {
        put_at("digest", i, digest[i] as Field);
    }
}
