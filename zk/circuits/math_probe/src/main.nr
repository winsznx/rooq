// Test-only: executes the circuit fixed-point math on vectors from the independent risk kernel
// (contracts/test/vectors/risk_vectors.json). Never proved or deployed; no verifier is generated for it.
//   op 0: margin_requirement(a, b, c, d) == expected
//   op 1: fee(a, b, c, d) == expected
//   op 2: pair_pnl(is_short, a, b, c, d): expected = floor magnitude, expected2 = ceil magnitude, gains = direction
//   op 3: amount_out(a, b, c, d) == expected
//   op 4: floor_sqrt(a) == expected
use rooq_zk::{amount_out, fee, floor_sqrt, margin_requirement, pair_pnl};

fn main(op: Field, a: Field, b: Field, c: Field, d: Field, is_short: Field, expected: Field, expected2: Field, gains: bool) {
    if op == 0 {
        assert_eq(margin_requirement(a, b, c, d), expected);
    } else if op == 1 {
        assert_eq(fee(a, b, c, d), expected);
    } else if op == 3 {
        assert_eq(amount_out(a, b, c, d), expected);
    } else if op == 4 {
        assert_eq(floor_sqrt(a), expected);
    } else {
        let p = pair_pnl(is_short, a, b, c, d);
        assert_eq(p.floor, expected);
        assert_eq(p.ceil, expected2);
        if p.floor != 0 {
            assert_eq(p.taker_gains, gains);
        }
    }
}
