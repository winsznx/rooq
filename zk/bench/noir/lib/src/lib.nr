// Shared primitives for the ADR-P03 benchmark statements (zk/bench/STATEMENT.md).
use poseidon::poseidon2::Poseidon2;
use std::embedded_curve_ops::{
    EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul, multi_scalar_mul,
};

pub global TREE_DEPTH: u32 = 32;
pub global AMOUNT_BITS: u32 = 100;

pub global T_AUTH: Field = 1;
pub global T_NK: Field = 2;
pub global T_OWNER: Field = 3;
pub global T_NOTE: Field = 4;
pub global T_NF: Field = 5;
pub global T_NF_REC: Field = 6;
pub global T_NODE: Field = 7;
pub global T_ENC: Field = 8;
pub global T_CT: Field = 9;
pub global T_TAKER: Field = 10;
pub global T_QUOTE: Field = 11;
pub global T_ORACLE: Field = 12;
pub global T_PAIR: Field = 13;
pub global T_MAKER: Field = 14;

pub fn h<let N: u32>(input: [Field; N]) -> Field {
    Poseidon2::hash(input, N)
}

pub fn assert_amount(x: Field) {
    x.assert_max_bit_size::<AMOUNT_BITS>();
}

/// a <= b for values already range-checked below the field modulus half.
pub fn assert_le(a: Field, b: Field) {
    assert(!b.lt(a));
}

pub struct Note {
    pub domain: Field,
    pub asset: Field,
    pub value: Field,
    pub owner: Field,
    pub rho: Field,
    pub blind: Field,
}

impl Note {
    pub fn commit(self, deployment: Field) -> Field {
        h([T_NOTE, deployment, self.domain, self.asset, self.value, self.owner, self.rho, self.blind])
    }
}

pub fn owner_tag(auth: Field, pk: EmbeddedCurvePoint) -> Field {
    h([T_OWNER, auth, pk.x, pk.y])
}

pub fn merkle_root(leaf: Field, index: Field, path: [Field; TREE_DEPTH]) -> Field {
    let bits: [bool; TREE_DEPTH] = index.to_le_bits();
    let mut node = leaf;
    for i in 0..TREE_DEPTH {
        let (l, r) = if bits[i] { (path[i], node) } else { (node, path[i]) };
        node = h([T_NODE, l, r]);
    }
    node
}

/// Grumpkin: y^2 = x^3 - 17. Points supplied as witnesses are not checked by the curve ops.
pub fn assert_on_curve(p: EmbeddedCurvePoint) {
    assert_eq(p.y * p.y, p.x * p.x * p.x - 17);
}

pub fn enc_pubkey(secret: Field) -> EmbeddedCurvePoint {
    fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(secret))
}

/// Encrypts `pt` to `pk` with ephemeral scalar `e` and returns the public ciphertext hash.
pub fn encrypt_hash<let N: u32>(pt: [Field; N], pk: EmbeddedCurvePoint, e: Field) -> Field {
    assert_on_curve(pk);
    let es = EmbeddedCurveScalar::from_field(e);
    let eph = fixed_base_scalar_mul(es);
    let shared = multi_scalar_mul([pk], [es]);
    assert(!shared.is_infinite());
    let mut acc = [0; N + 3];
    acc[0] = T_CT;
    acc[1] = eph.x;
    acc[2] = eph.y;
    for i in 0..N {
        acc[i + 3] = pt[i] + h([T_ENC, shared.x, i as Field]);
    }
    h(acc)
}

/// ceil(a / b) for a < 2^248, 0 < b < 2^120 and a quotient below 2^128.
pub fn ceil_div(a: Field, b: Field) -> Field {
    // Safety: constrained below by a <= q*b < a + b with q*b far below the field modulus.
    let q = unsafe { ceil_div_hint(a, b) };
    q.assert_max_bit_size::<128>();
    b.assert_max_bit_size::<120>();
    assert(b != 0);
    let prod = q * b;
    assert_le(a, prod);
    assert(prod.lt(a + b));
    q
}

unconstrained fn ceil_div_hint(a: Field, b: Field) -> Field {
    let a128 = a as u128;
    let b128 = b as u128;
    if (a == a128 as Field) & (b == b128 as Field) {
        ((a128 + b128 - 1) / b128) as Field
    } else {
        big_ceil_div(a, b)
    }
}

unconstrained fn big_ceil_div(a: Field, b: Field) -> Field {
    // Long division over 254-bit values using bit decomposition.
    let a_bits: [bool; 254] = a.to_be_bits();
    let mut q: Field = 0;
    let mut r: Field = 0;
    for i in 0..254 {
        r = r * 2 + (a_bits[i] as Field);
        q = q * 2;
        if !r.lt(b) {
            r = r - b;
            q = q + 1;
        }
    }
    if r != 0 { q + 1 } else { q }
}

pub fn bytes32(x: Field) -> [u8; 32] {
    x.to_be_bytes()
}

pub fn keccak<let N: u32>(input: [u8; N]) -> [u8; 32] {
    keccak256::keccak256(input, N)
}

/// Test-only helper: path of `depth` filler siblings above two adjacent leaves at indices 0 and 1.
pub fn filler_path(sibling: Field) -> [Field; TREE_DEPTH] {
    let mut path = [0; TREE_DEPTH];
    path[0] = sibling;
    for i in 1..TREE_DEPTH {
        path[i] = h([99, i as Field]);
    }
    path
}

/// Test-only output for zk/bench/toml.py: `name [index...] value`, one per line.
pub fn put<let N: u32>(name: str<N>, v: Field) {
    println(f"W {name} {v}");
}

pub fn put_at<let N: u32>(name: str<N>, i: u32, v: Field) {
    println(f"W {name} {i} {v}");
}

pub fn put_at2<let N: u32>(name: str<N>, i: u32, j: u32, v: Field) {
    println(f"W {name} {i} {j} {v}");
}
