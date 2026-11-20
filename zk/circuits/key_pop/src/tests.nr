use crate::main;
use std::embedded_curve_ops::{EmbeddedCurveScalar, fixed_base_scalar_mul};

#[test]
fn accepts_the_holder_of_the_key() {
    let pk = fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(11));
    main(11, 31337, 4, 2, pk.x, pk.y);
}

#[test(should_fail_with = "not this key")]
fn refuses_another_secret() {
    let pk = fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(11));
    main(12, 31337, 4, 2, pk.x, pk.y);
}

#[test(should_fail_with = "not this key")]
fn refuses_the_negated_point() {
    let pk = fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(11));
    main(11, 31337, 4, 2, pk.x, 0 - pk.y);
}
