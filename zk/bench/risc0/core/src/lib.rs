//! ADR-P03 benchmark statements (zk/bench/STATEMENT.md) for the RISC Zero guest.
//! SHA-256 replaces Poseidon2 and secp256k1 replaces Grumpkin; every check matches the Noir circuits.
#![no_std]
extern crate alloc;

use alloc::vec::Vec;
use k256::{
    ecdsa::{signature::hazmat::PrehashVerifier, Signature, VerifyingKey},
    elliptic_curve::{ops::MulByGenerator, sec1::ToEncodedPoint, PrimeField},
    AffinePoint, ProjectivePoint, Scalar,
};
use ruint::aliases::U256;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tiny_keccak::{Hasher, Keccak};

pub type W = [u8; 32];
pub const TREE_DEPTH: usize = 32;
pub const AMOUNT_BITS: u32 = 100;

pub const T_AUTH: u8 = 1;
pub const T_NK: u8 = 2;
pub const T_OWNER: u8 = 3;
pub const T_NOTE: u8 = 4;
pub const T_NF: u8 = 5;
pub const T_NF_REC: u8 = 6;
pub const T_NODE: u8 = 7;
pub const T_ENC: u8 = 8;
pub const T_CT: u8 = 9;
pub const T_TAKER: u8 = 10;
pub const T_QUOTE: u8 = 11;
pub const T_ORACLE: u8 = 12;
pub const T_PAIR: u8 = 13;
pub const T_MAKER: u8 = 14;
pub const FREE_DOMAIN: u128 = 0;
pub const FEE_DOMAIN: u128 = 2;

/// keccak256("Quote(bytes32 marketId,address maker,bytes32 taker,int256 size,uint256 price,uint256 minFill,uint256 nonce,uint64 deadline,uint32 policyVersion)")
pub const QUOTE_TYPEHASH: W = [
    3, 13, 188, 78, 110, 201, 53, 60, 110, 252, 4, 192, 248, 126, 200, 150, 179, 78, 214, 204, 147, 7, 176, 30, 36,
    86, 14, 50, 151, 78, 137, 81,
];

pub fn h(tag: u8, parts: &[&[u8]]) -> W {
    let mut s = Sha256::new();
    s.update([tag]);
    for p in parts {
        s.update(p);
    }
    s.finalize().into()
}

pub fn keccak(data: &[u8]) -> W {
    let mut k = Keccak::v256();
    k.update(data);
    let mut out = [0u8; 32];
    k.finalize(&mut out);
    out
}

pub fn word(x: u128) -> W {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&x.to_be_bytes());
    w
}

fn amount(x: u128) -> u128 {
    assert!(x < 1u128 << AMOUNT_BITS, "amount out of range");
    x
}

#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct Note {
    pub domain: W,
    pub asset: W,
    pub value: u128,
    pub owner: W,
    pub rho: W,
    pub blind: W,
}

impl Note {
    pub fn commit(&self, deployment: &W) -> W {
        h(T_NOTE, &[deployment, &self.domain, &self.asset, &word(self.value), &self.owner, &self.rho, &self.blind])
    }
}

/// Compressed SEC1 point (33 bytes) used as an encryption key.
pub type Pk = Vec<u8>;

pub fn scalar(sk: &W) -> Scalar {
    Option::from(Scalar::from_repr((*sk).into())).expect("scalar out of range")
}

pub fn enc_pubkey(sk: &W) -> Pk {
    ProjectivePoint::mul_by_generator(&scalar(sk)).to_affine().to_encoded_point(true).as_bytes().to_vec()
}

fn point(pk: &[u8]) -> ProjectivePoint {
    let ep = k256::EncodedPoint::from_bytes(pk).expect("bad point encoding");
    let a: Option<AffinePoint> = k256::elliptic_curve::sec1::FromEncodedPoint::from_encoded_point(&ep).into();
    ProjectivePoint::from(a.expect("point not on curve"))
}

pub fn owner_tag(auth: &W, pk: &[u8]) -> W {
    h(T_OWNER, &[auth, pk])
}

pub fn merkle_root(leaf: W, index: u32, path: &[W; TREE_DEPTH]) -> W {
    let mut node = leaf;
    for (i, sib) in path.iter().enumerate() {
        node = if (index >> i) & 1 == 1 { h(T_NODE, &[sib, &node]) } else { h(T_NODE, &[&node, sib]) };
    }
    node
}

/// Encrypts `pt` to `pk` with ephemeral scalar `e`; returns the public ciphertext hash.
pub fn encrypt_hash(pt: &[W], pk: &[u8], e: &W) -> W {
    let es = scalar(e);
    let eph = ProjectivePoint::mul_by_generator(&es).to_affine().to_encoded_point(true);
    let shared = (point(pk) * es).to_affine().to_encoded_point(true);
    let mut acc: Vec<u8> = Vec::with_capacity(33 + 32 * pt.len());
    acc.extend_from_slice(eph.as_bytes());
    for (i, w) in pt.iter().enumerate() {
        let ks = h(T_ENC, &[&shared.as_bytes()[1..], &(i as u32).to_be_bytes()]);
        acc.extend(w.iter().zip(ks.iter()).map(|(a, b)| a ^ b));
    }
    h(T_CT, &[&acc])
}

fn ceil_div(a: U256, b: U256) -> U256 {
    a.div_ceil(b)
}

fn u(x: u128) -> U256 {
    U256::from(x)
}

// ---------- Op A: transfer ----------

#[derive(Clone, Serialize, Deserialize)]
pub struct TransferOutput {
    pub value: u128,
    pub recipient_auth: W,
    pub recipient_pk: Pk,
    pub rho: W,
    pub blind: W,
    pub eph: W,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TransferWitness {
    pub sk: W,
    pub enc_sk: W,
    pub in_values: [u128; 2],
    pub in_rho: [W; 2],
    pub in_blind: [W; 2],
    pub in_index: [u32; 2],
    pub in_path: [[W; TREE_DEPTH]; 2],
    pub outs: [TransferOutput; 2],
    pub deployment: W,
    pub domain: W,
    pub asset: W,
    pub fee: u128,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct TransferJournal {
    pub root: W,
    pub nf: [W; 2],
    pub cm_out: [W; 2],
    pub ct_hash: [W; 2],
    pub deployment: W,
    pub domain: W,
    pub asset: W,
    pub fee: u128,
}

pub fn transfer(w: &TransferWitness) -> TransferJournal {
    let auth = h(T_AUTH, &[&w.sk]);
    let nk = h(T_NK, &[&w.sk]);
    let owner = owner_tag(&auth, &enc_pubkey(&w.enc_sk));
    let mut root = None;
    let mut nf = [[0u8; 32]; 2];
    let mut total_in: u128 = 0;
    for i in 0..2 {
        let note = Note {
            domain: w.domain, asset: w.asset, value: amount(w.in_values[i]), owner, rho: w.in_rho[i],
            blind: w.in_blind[i],
        };
        let cm = note.commit(&w.deployment);
        let r = merkle_root(cm, w.in_index[i], &w.in_path[i]);
        assert!(root.map_or(true, |x| x == r), "inputs under different roots");
        root = Some(r);
        nf[i] = h(T_NF, &[&nk, &cm]);
        total_in += w.in_values[i];
    }
    assert!(nf[0] != nf[1], "duplicate nullifier");
    let mut total_out = amount(w.fee);
    let mut cm_out = [[0u8; 32]; 2];
    let mut ct_hash = [[0u8; 32]; 2];
    for (i, o) in w.outs.iter().enumerate() {
        let note = Note {
            domain: w.domain, asset: w.asset, value: amount(o.value),
            owner: owner_tag(&o.recipient_auth, &o.recipient_pk), rho: o.rho, blind: o.blind,
        };
        cm_out[i] = note.commit(&w.deployment);
        ct_hash[i] = encrypt_hash(&[w.domain, w.asset, word(o.value), o.rho, o.blind], &o.recipient_pk, &o.eph);
        total_out += o.value;
    }
    assert_eq!(total_in, total_out, "value not conserved");
    TransferJournal {
        root: root.expect("two inputs"), nf, cm_out, ct_hash, deployment: w.deployment, domain: w.domain,
        asset: w.asset, fee: w.fee,
    }
}

// ---------- Op B: perp open ----------

#[derive(Clone, Serialize, Deserialize)]
pub struct Quote {
    pub maker: [u8; 20],
    pub size_abs: u128,
    pub is_long: bool,
    pub price: u128,
    pub min_fill: u128,
    pub nonce: u128,
    pub deadline: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PerpWitness {
    pub sk: W,
    pub enc_sk: W,
    pub taker_value: u128,
    pub taker_rho: W,
    pub taker_blind: W,
    pub taker_index: u32,
    pub taker_path: [W; TREE_DEPTH],
    pub maker_value: u128,
    pub maker_rho: W,
    pub maker_blind: W,
    pub maker_rec_nonce: W,
    pub maker_index: u32,
    pub maker_path: [W; TREE_DEPTH],
    pub oracle_price: u128,
    pub oracle_epoch: u64,
    pub taker_margin: u128,
    pub maker_margin: u128,
    pub funding_snapshot: W,
    pub pair_nonce: W,
    pub pair_blind: W,
    pub change_rho: W,
    pub change_blind: W,
    pub maker_change_rho: W,
    pub maker_change_blind: W,
    pub fee_rho: W,
    pub fee_blind: W,
    pub eph_risk: W,
    pub eph_owner: W,
    pub quote: Quote,
    /// Uncompressed SEC1 maker key (65 bytes) and 64-byte r||s signature.
    pub maker_pubkey: Vec<u8>,
    pub signature: Vec<u8>,
    pub params: PerpParams,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct PerpParams {
    pub batch_time: u64,
    pub domain_separator: W,
    pub deployment: W,
    pub policy_version: u32,
    pub risk_pk: Pk,
    pub market: W,
    pub collateral: W,
    pub imr_bps: u128,
    pub fee_bps: u128,
    pub max_dev_bps: u128,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct PerpJournal {
    pub root: W,
    pub nf_taker: W,
    pub nf_maker: W,
    pub quote_id: W,
    pub cm_pair: W,
    pub cm_taker_change: W,
    pub cm_maker_change: W,
    pub cm_fee: W,
    pub ct_pair_risk: W,
    pub ct_pair_owner: W,
    pub oracle_cm: W,
    pub params: PerpParams,
}

fn signed_word(abs: u128, is_long: bool) -> W {
    let v = U256::from(abs);
    let v = if is_long { v } else { v.wrapping_neg() };
    v.to_be_bytes()
}

fn addr_word(a: &[u8; 20]) -> W {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

pub fn quote_digest(p: &PerpParams, taker: &W, q: &Quote) -> W {
    let mut buf = Vec::with_capacity(320);
    for wd in [
        QUOTE_TYPEHASH, p.market, addr_word(&q.maker), *taker, signed_word(q.size_abs, q.is_long), word(q.price),
        word(q.min_fill), word(q.nonce), word(q.deadline as u128), word(p.policy_version as u128),
    ] {
        buf.extend_from_slice(&wd);
    }
    let sh = keccak(&buf);
    let mut msg = Vec::with_capacity(66);
    msg.extend_from_slice(&[0x19, 0x01]);
    msg.extend_from_slice(&p.domain_separator);
    msg.extend_from_slice(&sh);
    keccak(&msg)
}

pub fn pair_plaintext(p: &PerpParams, w: &PerpWitness, taker_owner: &W, maker_owner: &W) -> [W; 11] {
    let q = &w.quote;
    [
        p.market, word(q.size_abs), word(q.is_long as u128), word(q.price), word(w.taker_margin),
        word(w.maker_margin), w.funding_snapshot, *taker_owner, *maker_owner, w.pair_nonce, w.pair_blind,
    ]
}

pub fn perp_open(w: &PerpWitness) -> PerpJournal {
    let p = &w.params;
    let q = &w.quote;
    let auth = h(T_AUTH, &[&w.sk]);
    let nk = h(T_NK, &[&w.sk]);
    let taker_pk = enc_pubkey(&w.enc_sk);
    let taker_owner = owner_tag(&auth, &taker_pk);
    let free = word(FREE_DOMAIN);
    let taker_cm = Note {
        domain: free, asset: p.collateral, value: amount(w.taker_value), owner: taker_owner, rho: w.taker_rho,
        blind: w.taker_blind,
    }
    .commit(&p.deployment);
    let root = merkle_root(taker_cm, w.taker_index, &w.taker_path);
    let nf_taker = h(T_NF, &[&nk, &taker_cm]);

    let taker_binding = h(T_TAKER, &[&taker_owner]);
    let digest = quote_digest(p, &taker_binding, q);
    let vk = VerifyingKey::from_sec1_bytes(&w.maker_pubkey).expect("maker key");
    let sig = Signature::from_slice(&w.signature).expect("signature encoding");
    vk.verify_prehash(&digest, &sig).expect("maker signature");
    let addr = keccak(&w.maker_pubkey[1..]);
    assert_eq!(&addr[12..], &q.maker, "maker address");
    assert!(p.batch_time <= q.deadline, "quote expired at batch time");
    let quote_id = h(T_QUOTE, &[&q.maker, &word(q.nonce)]);

    let maker_owner = h(T_MAKER, &[&q.maker]);
    let maker_cm = Note {
        domain: p.market, asset: p.collateral, value: amount(w.maker_value), owner: maker_owner, rho: w.maker_rho,
        blind: w.maker_blind,
    }
    .commit(&p.deployment);
    assert_eq!(merkle_root(maker_cm, w.maker_index, &w.maker_path), root, "maker record not in tree");
    let nf_maker = h(T_NF_REC, &[&maker_cm, &w.maker_rec_nonce]);

    let oracle_cm = h(T_ORACLE, &[&p.market, &word(w.oracle_price), &word(w.oracle_epoch as u128)]);
    amount(w.oracle_price);
    amount(q.price);
    amount(q.size_abs);
    assert!(q.size_abs != 0);
    let diff = q.price.abs_diff(w.oracle_price);
    assert!(u(diff) * u(10_000) <= u(p.max_dev_bps) * u(w.oracle_price), "price deviation");

    let e30 = U256::from(10u8).pow(U256::from(30u8));
    let notional = ceil_div(u(q.size_abs) * u(q.price), e30);
    let fee = ceil_div(notional * u(p.fee_bps), u(10_000));
    amount(w.taker_margin);
    amount(w.maker_margin);
    assert!(notional * u(p.imr_bps) <= u(w.taker_margin) * u(10_000), "taker initial margin");
    assert!(notional * u(p.imr_bps) <= u(w.maker_margin) * u(10_000), "maker initial margin");
    let fee: u128 = fee.to();
    let taker_spent = w.taker_margin + fee;
    assert!(taker_spent <= w.taker_value && w.maker_margin <= w.maker_value, "insufficient input");

    let pt = pair_plaintext(p, w, &taker_owner, &maker_owner);
    let mut pair_in: Vec<u8> = Vec::with_capacity(32 * 12);
    pair_in.extend_from_slice(&p.deployment);
    for x in &pt {
        pair_in.extend_from_slice(x);
    }
    let cm_pair = h(T_PAIR, &[&pair_in]);
    let ct_pair_risk = encrypt_hash(&pt, &p.risk_pk, &w.eph_risk);
    let ct_pair_owner = encrypt_hash(&pt, &taker_pk, &w.eph_owner);
    let cm_taker_change = Note {
        domain: free, asset: p.collateral, value: w.taker_value - taker_spent, owner: taker_owner, rho: w.change_rho,
        blind: w.change_blind,
    }
    .commit(&p.deployment);
    let cm_maker_change = Note {
        domain: p.market, asset: p.collateral, value: w.maker_value - w.maker_margin, owner: maker_owner,
        rho: w.maker_change_rho, blind: w.maker_change_blind,
    }
    .commit(&p.deployment);
    let cm_fee = Note {
        domain: word(FEE_DOMAIN), asset: p.collateral, value: fee, owner: p.market, rho: w.fee_rho, blind: w.fee_blind,
    }
    .commit(&p.deployment);

    PerpJournal {
        root, nf_taker, nf_maker, quote_id, cm_pair, cm_taker_change, cm_maker_change, cm_fee, ct_pair_risk,
        ct_pair_owner, oracle_cm, params: p.clone(),
    }
}

#[derive(Serialize, Deserialize)]
pub enum Op {
    Transfer(TransferWitness),
    PerpOpen(PerpWitness),
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
pub enum Journal {
    Transfer(TransferJournal),
    PerpOpen(PerpJournal),
}

pub fn run(op: &Op) -> Journal {
    match op {
        Op::Transfer(w) => Journal::Transfer(transfer(w)),
        Op::PerpOpen(w) => Journal::PerpOpen(perp_open(w)),
    }
}
