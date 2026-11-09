//! Rooq risk kernel: a deterministic integer reference model of the onchain settlement math.
//!
//! Every function here mirrors `contracts/src/lib/RiskMath.sol` or `contracts/src/lib/SpotMath.sol`
//! with identical rounding, and [`pair::PairSim`] mirrors the ClearingHouse state machine for one
//! taker/maker pair. `cargo run --bin gen-vectors` writes shared vectors that
//! `contracts/test/RiskParity.t.sol` replays against the Solidity code.
//!
//! This crate is NOT authoritative. The deployed contracts are. It exists so the arithmetic has an
//! independent implementation that can be fuzzed and diffed.
//!
//! Supported range: intermediate products must fit in 256 bits. Every function panics on overflow
//! instead of wrapping, so an out-of-range input can never yield a silently different answer.

pub mod pair;
pub mod private_pair;

use ethnum::{I256, U256};

pub const WAD: U256 = U256::new(1_000_000_000_000_000_000);
pub const BPS: U256 = U256::new(10_000);

fn wad_i() -> I256 {
    I256::new(1_000_000_000_000_000_000)
}

pub fn to_i(x: U256) -> I256 {
    assert!(x <= U256::from(I256::MAX.as_u256()), "value exceeds int256");
    x.as_i256()
}

pub fn abs(x: I256) -> U256 {
    x.unsigned_abs()
}

fn mul(a: U256, b: U256) -> U256 {
    a.checked_mul(b).expect("u256 multiplication overflow")
}

fn imul(a: I256, b: I256) -> I256 {
    a.checked_mul(b).expect("i256 multiplication overflow")
}

pub fn ceil_div(a: U256, b: U256) -> U256 {
    if a == U256::ZERO {
        U256::ZERO
    } else {
        (a - 1u128) / b + 1u128
    }
}

pub fn mul_div_ceil(a: U256, b: U256, c: U256) -> U256 {
    ceil_div(mul(a, b), c)
}

pub fn notional_up(abs_size: U256, price: U256) -> U256 {
    mul_div_ceil(abs_size, price, WAD)
}

/// Collateral required for `abs_size` at `price` under `fraction_wad`, in collateral units. Rounds up.
pub fn margin_requirement(abs_size: U256, price: U256, fraction_wad: U256, scale: U256) -> U256 {
    let req_wad = mul_div_ceil(notional_up(abs_size, price), fraction_wad, WAD);
    ceil_div(req_wad, scale)
}

pub fn fee(abs_size: U256, price: U256, fee_bps: U256, scale: U256) -> U256 {
    let fee_wad = mul_div_ceil(notional_up(abs_size, price), fee_bps, BPS);
    ceil_div(fee_wad, scale)
}

fn raw_pnl(size: I256, entry: U256, exit: U256) -> I256 {
    imul(size, to_i(exit) - to_i(entry))
}

/// Realised PnL in collateral units, truncated toward zero (used for transfers).
pub fn pnl_trunc(size: I256, entry: U256, exit: U256, scale: U256) -> I256 {
    raw_pnl(size, entry, exit) / to_i(mul(WAD, scale))
}

/// Unrealised PnL in collateral units, rounded toward negative infinity (used for health checks).
pub fn pnl_floor(size: I256, entry: U256, mark: U256, scale: U256) -> I256 {
    floor_div(raw_pnl(size, entry, mark), to_i(mul(WAD, scale)))
}

pub fn floor_div(a: I256, b: I256) -> I256 {
    let q = a / b;
    if a % b != I256::ZERO && ((a < I256::ZERO) != (b < I256::ZERO)) {
        q - 1i128
    } else {
        q
    }
}

pub fn weighted_entry(abs_old: U256, old_entry: U256, abs_add: U256, add_price: U256) -> U256 {
    (mul(abs_old, old_entry) + mul(abs_add, add_price)) / (abs_old + abs_add)
}

/// Skew-based funding rate per second as a WAD fraction of price. Positive: longs pay.
pub fn funding_rate_per_second(long_oi: U256, short_oi: U256, max_rate_per_hour_wad: U256) -> I256 {
    let total = long_oi + short_oi;
    if total == U256::ZERO {
        return I256::ZERO;
    }
    let max_per_second = to_i(max_rate_per_hour_wad / U256::new(3600));
    let skew_wad = imul(to_i(long_oi) - to_i(short_oi), wad_i()) / to_i(total);
    imul(max_per_second, skew_wad) / wad_i()
}

pub fn funding_index_delta(rate_per_second: I256, dt: U256, price: U256) -> I256 {
    imul(imul(rate_per_second, to_i(dt)), to_i(price)) / wad_i()
}

/// Funding owed by the taker side, in collateral units; magnitude rounded up against the payer.
pub fn funding_owed(size: I256, index_delta: I256, scale: U256) -> I256 {
    let raw = imul(size, index_delta);
    if raw == I256::ZERO {
        return I256::ZERO;
    }
    let mag = to_i(ceil_div(abs(raw), mul(WAD, scale)));
    if raw > I256::ZERO {
        mag
    } else {
        -mag
    }
}

pub fn liquidation_penalty(abs_size: U256, mark: U256, penalty_bps: U256, scale: U256) -> U256 {
    fee(abs_size, mark, penalty_bps, scale)
}

// ---------------------------------------------------------------- spot

pub fn get_amount_out(amount_in: U256, reserve_in: U256, reserve_out: U256, fee_bps: U256) -> U256 {
    if amount_in == U256::ZERO || reserve_in == U256::ZERO || reserve_out == U256::ZERO {
        return U256::ZERO;
    }
    let in_with_fee = mul(amount_in, BPS - fee_bps);
    mul(in_with_fee, reserve_out) / (mul(reserve_in, BPS) + in_with_fee)
}

/// Floor of the square root, matching OpenZeppelin `Math.sqrt`.
pub fn sqrt(x: U256) -> U256 {
    if x < U256::new(2) {
        return x;
    }
    let mut z = x;
    let mut y = (x >> 1) + (x & U256::ONE);
    while y < z {
        z = y;
        y = (x / y + y) >> 1;
    }
    z
}

pub fn shares_for(amount0: U256, amount1: U256, reserve0: U256, reserve1: U256, supply: U256) -> U256 {
    let a = mul(amount0, supply) / reserve0;
    let b = mul(amount1, supply) / reserve1;
    a.min(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCALE_6: U256 = U256::new(1_000_000_000_000);

    fn w(x: u128) -> U256 {
        U256::new(x) * WAD
    }

    #[test]
    fn fee_matches_solidity_unit_test() {
        // 0.2 base at 66,000 with 6 bps, 6-decimal collateral = 7.92 USD.
        let f = fee(U256::new(200_000_000_000_000_000), w(66_000), U256::new(6), SCALE_6);
        assert_eq!(f, U256::new(7_920_000));
    }

    #[test]
    fn initial_margin_half_of_notional() {
        let im = margin_requirement(U256::new(200_000_000_000_000_000), w(60_000), WAD / 2, SCALE_6);
        assert_eq!(im, U256::new(6_000_000_000));
    }

    #[test]
    fn pnl_trunc_and_floor_differ_only_on_remainder() {
        let size = I256::new(1); // 1 wei of base
        let entry = w(60_000);
        let exit = w(60_000) - 1u128;
        assert_eq!(pnl_trunc(size, entry, exit, SCALE_6), I256::ZERO);
        assert_eq!(pnl_floor(size, entry, exit, SCALE_6), I256::new(-1));
    }

    #[test]
    fn opposite_sides_never_create_value() {
        for (size, entry, mark) in [(7i128, 3u128, 11u128), (-13, 101, 97), (1_000_003, 59_999, 60_001)] {
            let s = I256::new(size * 1_000_000_000_007);
            let e = U256::new(entry) * WAD + 13u128;
            let m = U256::new(mark) * WAD + 7u128;
            let t = pnl_trunc(s, e, m, SCALE_6);
            let k = pnl_trunc(-s, e, m, SCALE_6);
            assert_eq!(t + k, I256::ZERO, "realised transfers are exactly zero-sum");
            let tf = pnl_floor(s, e, m, SCALE_6);
            let kf = pnl_floor(-s, e, m, SCALE_6);
            assert!(tf + kf <= I256::ZERO, "health checks never sum to a credit");
        }
    }

    #[test]
    fn funding_rate_capped_at_full_skew() {
        let cap = U256::new(100_000_000_000_000); // 0.0001 / hour
        let r = funding_rate_per_second(U256::ZERO, w(1), cap);
        assert_eq!(r, -to_i(cap / U256::new(3600)));
        assert_eq!(funding_rate_per_second(w(1), w(1), cap), I256::ZERO);
    }

    #[test]
    fn funding_owed_rounds_against_payer() {
        let owed = funding_owed(I256::new(1), I256::new(1), SCALE_6);
        assert_eq!(owed, I256::new(1));
        let owed = funding_owed(I256::new(-1), I256::new(1), SCALE_6);
        assert_eq!(owed, I256::new(-1));
    }

    #[test]
    fn sqrt_is_floor() {
        for x in [0u128, 1, 2, 3, 4, 15, 16, 17, 999_999, 1_000_000, u64::MAX as u128] {
            let r = sqrt(U256::new(x));
            assert!(r * r <= U256::new(x));
            assert!((r + 1u128) * (r + 1u128) > U256::new(x));
        }
    }

    #[test]
    fn swap_keeps_k() {
        let (r_in, r_out) = (U256::new(120_000_000_000), w(2));
        let out = get_amount_out(U256::new(6_000_000_000), r_in, r_out, U256::new(25));
        assert!((r_in + U256::new(6_000_000_000)) * (r_out - out) >= r_in * r_out);
    }
}
