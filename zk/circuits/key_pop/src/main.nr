// Proof that whoever schedules an operator or fee key holds its secret (audit #18): pk = sk * G on Grumpkin, the same
// derivation `encrypt` uses. `deployment`, `epoch` and `slot` enter no constraint. As public inputs they are bound by the
// verifier transcript, so a proof made for one deployment, rotation or slot fails verification for any other.
use std::embedded_curve_ops::{EmbeddedCurveScalar, fixed_base_scalar_mul};

mod tests;

fn main(sk: Field, deployment: pub Field, epoch: pub Field, slot: pub Field, x: pub Field, y: pub Field) {
    let p = fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(sk));
    assert(!p.is_infinite(), "no key");
    assert_eq(p.x, x, "not this key");
    assert_eq(p.y, y, "not this key");
    let _ = (deployment, epoch, slot);
}
