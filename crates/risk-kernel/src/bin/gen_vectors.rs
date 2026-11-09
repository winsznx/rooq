//! Writes `contracts/test/vectors/risk_vectors.json`.
//!
//! The generator is deterministic (fixed SplitMix64 seed), so the file only changes when the math
//! changes. Every value is a decimal string so Foundry can decode it without precision loss.
//! Object keys are emitted in alphabetical order because Foundry decodes JSON objects into structs
//! by sorted key.

use ethnum::{I256, U256};
use rooq_risk_kernel::pair::{I256Str, Ledger, PairSim, PairState, Risk, Step, U256Str};
use rooq_risk_kernel::private_pair::{close_outcome, fold_claims, liquidation_outcome, update_outcome, Actor, ClosePolicy, PrivatePair, UpdateRequest};
use rooq_risk_kernel::*;
use serde_json::{json, Map, Value};
use std::path::PathBuf;

struct SplitMix(u64);

impl SplitMix {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u128) -> u128 {
        let v = ((self.next() as u128) << 64) | self.next() as u128;
        v % n
    }
    fn range(&mut self, lo: u128, hi: u128) -> U256 {
        U256::new(lo + self.below(hi - lo + 1))
    }
    fn pick<T: Copy>(&mut self, xs: &[T]) -> T {
        xs[self.below(xs.len() as u128) as usize]
    }
    fn signed(&mut self, lo: u128, hi: u128) -> I256 {
        let m = self.range(lo, hi).as_i256();
        if self.next() & 1 == 0 {
            m
        } else {
            -m
        }
    }
}

fn s<T: ToString>(x: T) -> Value {
    Value::String(x.to_string())
}

fn obj(pairs: Vec<(&str, Value)>) -> Value {
    let mut sorted = pairs;
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    let mut m = Map::new();
    for (k, v) in sorted {
        m.insert(k.to_string(), v);
    }
    Value::Object(m)
}

const WAD_U: u128 = 1_000_000_000_000_000_000;
const SCALES: [u128; 3] = [1, 10_000_000_000, 1_000_000_000_000];

fn main() {
    let mut r = SplitMix(0x726f_6f71_2026_1107);
    let mut out = Map::new();

    let mut v = Vec::new();
    for _ in 0..200 {
        let size = r.range(1, 1_000_000 * WAD_U);
        let price = r.range(WAD_U / 1000, 2_000_000 * WAD_U);
        let frac = r.range(150_000_000_000_000_000, WAD_U);
        let scale = U256::new(r.pick(&SCALES));
        v.push(obj(vec![
            ("absSize", s(size)),
            ("expected", s(margin_requirement(size, price, frac, scale))),
            ("fraction", s(frac)),
            ("price", s(price)),
            ("scale", s(scale)),
        ]));
    }
    out.insert("marginRequirement".into(), Value::Array(v));

    let mut v = Vec::new();
    for _ in 0..200 {
        let size = r.range(1, 1_000_000 * WAD_U);
        let price = r.range(WAD_U / 1000, 2_000_000 * WAD_U);
        let bps = r.range(0, 500);
        let scale = U256::new(r.pick(&SCALES));
        v.push(obj(vec![
            ("absSize", s(size)),
            ("bps", s(bps)),
            ("expected", s(fee(size, price, bps, scale))),
            ("price", s(price)),
            ("scale", s(scale)),
        ]));
    }
    out.insert("fee".into(), Value::Array(v));

    let mut v = Vec::new();
    for _ in 0..300 {
        let size = r.signed(1, 1_000_000 * WAD_U);
        let entry = r.range(WAD_U / 1000, 2_000_000 * WAD_U);
        let exit = r.range(WAD_U / 1000, 2_000_000 * WAD_U);
        let scale = U256::new(r.pick(&SCALES));
        v.push(obj(vec![
            ("entry", s(entry)),
            ("exit", s(exit)),
            ("floor", s(pnl_floor(size, entry, exit, scale))),
            ("scale", s(scale)),
            ("size", s(size)),
            ("trunc", s(pnl_trunc(size, entry, exit, scale))),
        ]));
    }
    out.insert("pnl".into(), Value::Array(v));

    let mut v = Vec::new();
    for _ in 0..100 {
        let a = r.range(1, 1_000_000 * WAD_U);
        let pa = r.range(WAD_U / 1000, 2_000_000 * WAD_U);
        let b = r.range(1, 1_000_000 * WAD_U);
        let pb = r.range(WAD_U / 1000, 2_000_000 * WAD_U);
        v.push(obj(vec![
            ("absAdd", s(b)),
            ("absOld", s(a)),
            ("addPrice", s(pb)),
            ("expected", s(weighted_entry(a, pa, b, pb))),
            ("oldEntry", s(pa)),
        ]));
    }
    out.insert("weightedEntry".into(), Value::Array(v));

    let mut v = Vec::new();
    for _ in 0..100 {
        let long = if r.next() % 5 == 0 { U256::ZERO } else { r.range(1, 10_000_000 * WAD_U) };
        let short = if r.next() % 5 == 0 { U256::ZERO } else { r.range(1, 10_000_000 * WAD_U) };
        let max = r.range(0, 1_000_000_000_000_000);
        v.push(obj(vec![
            ("expected", s(funding_rate_per_second(long, short, max))),
            ("longOi", s(long)),
            ("maxPerHour", s(max)),
            ("shortOi", s(short)),
        ]));
    }
    out.insert("fundingRate".into(), Value::Array(v));

    let mut v = Vec::new();
    for _ in 0..100 {
        let rate = r.signed(0, 277_777_777_777);
        let dt = r.range(0, 30 * 86_400);
        let price = r.range(WAD_U / 1000, 2_000_000 * WAD_U);
        let delta = funding_index_delta(rate, dt, price);
        let size = r.signed(1, 1_000_000 * WAD_U);
        let scale = U256::new(r.pick(&SCALES));
        v.push(obj(vec![
            ("delta", s(delta)),
            ("dt", s(dt)),
            ("owed", s(funding_owed(size, delta, scale))),
            ("price", s(price)),
            ("rate", s(rate)),
            ("scale", s(scale)),
            ("size", s(size)),
        ]));
    }
    out.insert("funding".into(), Value::Array(v));

    let mut v = Vec::new();
    for _ in 0..200 {
        let amount_in = r.range(1, 1_000_000 * WAD_U);
        let r_in = r.range(1, 1_000_000_000 * WAD_U);
        let r_out = r.range(1, 1_000_000_000 * WAD_U);
        let fee_bps = U256::new(r.pick(&[5u128, 25, 100]));
        v.push(obj(vec![
            ("amountIn", s(amount_in)),
            ("expected", s(get_amount_out(amount_in, r_in, r_out, fee_bps))),
            ("feeBps", s(fee_bps)),
            ("reserveIn", s(r_in)),
            ("reserveOut", s(r_out)),
        ]));
    }
    out.insert("amountOut".into(), Value::Array(v));

    let mut v = Vec::new();
    for _ in 0..100 {
        let x = r.range(0, u128::MAX - 1) * r.range(0, u64::MAX as u128);
        v.push(obj(vec![("expected", s(sqrt(x))), ("x", s(x))]));
    }
    out.insert("sqrt".into(), Value::Array(v));

    out.insert("lifecycles".into(), Value::Array(vec![lifecycle_a(), lifecycle_b()]));

    // Drawn last so every earlier category keeps its existing values.
    let pair_case = |r: &mut SplitMix| {
        let scale = U256::new(r.pick(&SCALES[1..]));
        let size = r.signed(WAD_U / 100, 10_000 * WAD_U);
        let entry = r.range(WAD_U, 5_000 * WAD_U);
        // Marks within about 40% of entry, so healthy and unhealthy pairs both occur.
        let span = entry.as_u128() * 2 / 5;
        let mark = U256::new(entry.as_u128() - span + r.below(2 * span));
        let notional = (size.unsigned_abs() * entry / WAD / scale).as_u128().max(10);
        let p = PrivatePair {
            size,
            entry,
            funding_snapshot: r.signed(0, 40 * WAD_U),
            taker_margin: r.range(1, notional),
            maker_margin: r.range(1, notional),
            close_spread_bps: r.range(0, 200),
            funding_debt: if r.next() & 1 == 0 { I256::ZERO } else { r.signed(0, notional / 2) },
        };
        (p, scale, mark, r.signed(0, 40 * WAD_U))
    };
    let pair_fields = |p: &PrivatePair, scale: U256, mark: U256, index: I256| {
        vec![
            ("closeSpreadBps", s(p.close_spread_bps)),
            ("entry", s(p.entry)),
            ("fundingDebt", s(p.funding_debt)),
            ("fundingIndex", s(index)),
            ("fundingSnapshot", s(p.funding_snapshot)),
            ("makerMargin", s(p.maker_margin)),
            ("mark", s(mark)),
            ("scale", s(scale)),
            ("size", s(p.size)),
            ("takerMargin", s(p.taker_margin)),
        ]
    };

    let mut v = Vec::new();
    for _ in 0..300 {
        let (p, scale, mark, index) = pair_case(&mut r);
        let mmr = r.range(WAD_U / 50, WAD_U / 10);
        let penalty_bps = r.range(50, 200);
        let o = liquidation_outcome(&p, mark, mmr, penalty_bps, scale, index);
        let mut f = pair_fields(&p, scale, mark, index);
        f.extend(vec![
            ("mmrWad", s(mmr)),
            ("penaltyBps", s(penalty_bps)),
            ("takerBad", json!(o.taker_bad)),
            ("makerBad", json!(o.maker_bad)),
            ("takerOut", s(o.taker_out)),
            ("makerOut", s(o.maker_out)),
            ("reward", s(o.reward)),
            ("toInsurance", s(o.to_insurance)),
            ("claim", s(o.claim)),
            ("fundingOwed", s(o.funding.owed)),
            ("fundingPaid", s(o.funding.paid)),
            ("fundingNetted", s(o.funding.netted)),
            ("fundingWrittenOff", s(o.funding.written_off)),
        ]);
        v.push(obj(f));
    }
    out.insert("privateLiquidation".into(), Value::Array(v));

    let mut v = Vec::new();
    for i in 0..300u32 {
        let (p, scale, mark, index) = pair_case(&mut r);
        let policy = [ClosePolicy::Taker, ClosePolicy::Mark, ClosePolicy::Entry][(i % 3) as usize];
        let fee_bps = r.range(0, 50);
        let o = close_outcome(&p, policy, mark, scale, index, fee_bps);
        let mut f = pair_fields(&p, scale, mark, index);
        f.extend(vec![
            ("mode", s(i % 3)),
            ("feeBps", s(fee_bps)),
            ("fee", s(o.fee)),
            ("fill", s(o.fill)),
            ("takerOut", s(o.taker_out)),
            ("makerOut", s(o.maker_out)),
            ("shortPaid", s(o.short_paid)),
            ("fundingOwed", s(o.funding.owed)),
            ("fundingPaid", s(o.funding.paid)),
            ("fundingNetted", s(o.funding.netted)),
            ("fundingWrittenOff", s(o.funding.written_off)),
        ]);
        v.push(obj(f));
    }
    out.insert("privateClose".into(), Value::Array(v));

    let mut v = Vec::new();
    for i in 0..300u32 {
        let (p, scale, mark, index) = pair_case(&mut r);
        let actor = [Actor::Nobody, Actor::Taker, Actor::Maker][(i % 3) as usize];
        let own = if actor == Actor::Maker { p.maker_margin } else { p.taker_margin }.as_u128();
        let add = if actor == Actor::Nobody { U256::ZERO } else { r.range(0, own) };
        let remove = if actor == Actor::Nobody || r.next() & 1 == 0 { U256::ZERO } else { r.range(0, own) };
        let reduce = if actor == Actor::Taker && r.next() & 1 == 0 { r.range(1, p.size.unsigned_abs().as_u128() - 1) } else { U256::ZERO };
        let extra = r.range(0, 5_000_000);
        let imr = r.range(WAD_U / 20, WAD_U / 4);
        let fee_bps = r.range(0, 50);
        let o = update_outcome(&p, UpdateRequest { actor, add, remove, reduce }, mark, imr, scale, index, fee_bps);
        let mut f = pair_fields(&p, scale, mark, index);
        f.extend(vec![
            ("actor", s(i % 3)),
            ("add", s(add)),
            ("remove", s(remove)),
            ("reduce", s(reduce)),
            ("noteValue", s(add + extra)),
            ("imrWad", s(imr)),
            ("feeBps", s(fee_bps)),
            ("refused", json!(o.refused)),
            ("nextTakerMargin", s(o.taker_margin)),
            ("nextMakerMargin", s(o.maker_margin)),
            ("nextSize", s(o.size)),
            ("nextFundingDebt", s(o.funding_debt)),
            ("fee", s(o.fee)),
            ("fundingOwed", s(o.funding.owed)),
            ("fundingPaid", s(o.funding.paid)),
            ("fundingNetted", s(o.funding.netted)),
        ]);
        v.push(obj(f));
    }
    out.insert("privateUpdate".into(), Value::Array(v));

    let mut v = Vec::new();
    for _ in 0..200 {
        let n = r.below(9) as usize;
        let claims: Vec<U256> = (0..n).map(|_| if r.next() & 3 == 0 { U256::ZERO } else { r.range(0, 10_000_000_000) }).collect();
        let insurance = if r.next() & 1 == 0 { U256::ZERO } else { r.range(0, 30_000_000_000) };
        let inflow = r.range(0, 10_000_000_000);
        let bond_left = if r.next() & 1 == 0 { U256::ZERO } else { r.range(0, 20_000_000_000) };
        let e = fold_claims(insurance, inflow, &claims, bond_left);
        v.push(obj(vec![
            ("insurance", s(insurance)),
            ("inflow", s(inflow)),
            ("bondLeft", s(bond_left)),
            ("bondUsedAdded", s(e.bond_used_added)),
            ("claims", Value::Array(claims.iter().map(|c| s(*c)).collect())),
            ("ratio", s(e.ratio)),
            ("insuranceNext", s(e.insurance_next)),
            ("badDebtAdded", s(e.bad_debt_added)),
            ("payouts", Value::Array(e.payouts.iter().map(|c| s(*c)).collect())),
        ]));
    }
    out.insert("privateEpochClaims".into(), Value::Array(v));

    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../contracts/test/vectors/risk_vectors.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let doc = json!({ "generator": "rooq-risk-kernel gen-vectors", "seed": "0x726f6f7120261107", "cases": Value::Object(out) });
    std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
    println!("wrote {}", path.display());
}

fn risk() -> Risk {
    Risk {
        imr_wad: U256Str(WAD / 2),
        mmr_wad: U256Str(U256::new(350_000_000_000_000_000)),
        taker_fee_bps: 6,
        max_funding_rate_per_hour_wad: U256Str(U256::new(100_000_000_000_000)),
        scale: U256Str(U256::new(1_000_000_000_000)),
    }
}

fn p(usd: u128) -> U256Str {
    U256Str(U256::new(usd) * WAD)
}

fn sz(x: i128) -> I256Str {
    I256Str(I256::new(x))
}

fn m(x: u128) -> U256Str {
    U256Str(U256::new(x))
}

/// Encodes a step as {kind, margin, mark, price, seconds, size}; kind 0 = trade, 1 = warp, 2 = settle.
fn step_json(step: &Step) -> Value {
    match step {
        Step::Trade { size, price, mark, margin } => obj(vec![
            ("kind", s(0)),
            ("margin", s(margin.0)),
            ("mark", s(mark.0)),
            ("price", s(price.0)),
            ("secs", s(0)),
            ("size", s(size.0)),
        ]),
        Step::Warp { seconds, mark } => obj(vec![
            ("kind", s(1)),
            ("margin", s(0)),
            ("mark", s(mark.0)),
            ("price", s(0)),
            ("secs", s(seconds)),
            ("size", s(0)),
        ]),
        Step::SettleFunding { mark } => obj(vec![
            ("kind", s(2)),
            ("margin", s(0)),
            ("mark", s(mark.0)),
            ("price", s(0)),
            ("secs", s(0)),
            ("size", s(0)),
        ]),
    }
}

fn run(name: &str, steps: Vec<Step>) -> Value {
    let taker_free = U256::new(50_000_000_000);
    let maker_commit = U256::new(300_000_000_000);
    let mut sim = PairSim::new(risk(), taker_free, maker_commit, 1_800_000_000);
    let total = sim.ledger.total();
    for st in &steps {
        sim.apply(st).unwrap_or_else(|e| panic!("{name}: step {st:?} rejected: {e:?}"));
        assert_eq!(sim.ledger.total(), total, "{name}: conservation");
    }
    let Ledger { taker_free: tf, taker_margin, maker_margin, maker_commit: mc, fees } = sim.ledger.clone();
    let PairState { size, entry_price, funding_index, .. } = sim.state.clone();
    obj(vec![
        ("name", Value::String(name.to_string())),
        ("steps", Value::Array(steps.iter().map(step_json).collect())),
        (
            "expected",
            obj(vec![
                ("entryPrice", s(entry_price.0)),
                ("fees", s(fees.0)),
                ("fundingIndex", s(funding_index.0)),
                ("makerCommit", s(mc.0)),
                ("makerMargin", s(maker_margin.0)),
                ("size", s(size.0)),
                ("takerFree", s(tf.0)),
                ("takerMargin", s(taker_margin.0)),
            ]),
        ),
    ])
}

/// 2x long, partial take-profit, adverse funding period, full close at a loss.
fn lifecycle_a() -> Value {
    run(
        "long-2x-reduce-funding-close",
        vec![
            Step::Trade { size: sz(200_000_000_000_000_000), price: p(60_000), mark: p(60_000), margin: m(8_000_000_000) },
            Step::Warp { seconds: 1_800, mark: p(61_000) },
            Step::Trade { size: sz(-50_000_000_000_000_000), price: p(61_000), mark: p(61_000), margin: m(0) },
            Step::Warp { seconds: 3_000, mark: p(59_500) },
            Step::SettleFunding { mark: p(59_500) },
            Step::Trade { size: sz(-150_000_000_000_000_000), price: p(59_400), mark: p(59_500), margin: m(0) },
        ],
    )
}

/// Short, increase at a worse price, funding received, partial close, position left open.
fn lifecycle_b() -> Value {
    run(
        "short-increase-funding-partial",
        vec![
            Step::Trade { size: sz(-100_000_000_000_000_000), price: p(60_000), mark: p(60_000), margin: m(4_000_000_000) },
            Step::Warp { seconds: 900, mark: p(59_000) },
            Step::Trade { size: sz(-100_000_000_000_000_000), price: p(59_100), mark: p(59_000), margin: m(3_000_000_000) },
            Step::Warp { seconds: 2_400, mark: p(58_000) },
            Step::SettleFunding { mark: p(58_000) },
            Step::Trade { size: sz(70_000_000_000_000_000), price: p(58_100), mark: p(58_000), margin: m(0) },
        ],
    )
}
