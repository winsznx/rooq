// Advances one market's funding (D-08). Folds the oldest pending market-state changes into the private market record and
// publishes the epoch's index change. A risk key holder can prove it, because the openings of every change come from pair
// and claim ciphertexts those keys read.
//
// Insurance (D-07): penalty shares in this batch are added first, then every claim in the batch is paid the same ratio,
// min(1, (insurance + unused creator bond) / claims), so a payout never depends on the order within the batch. Insurance is
// spent before the bond (PERP-07). The ratio is public and is exactly
// 1 whenever insurance covers everything, so it only reveals anything when a market is short. What remains unpaid is
// bad debt, which stays in the private record.
//
// The rate uses open interest from before this batch, as ClearingHouse accrues before changing OI. Same integer
// rules as RiskMath: each step truncates toward zero. `dt` and `mark` come from the contract.
use rooq_zk::{
    assert_amount, encrypt, floor_div, market_head, MARKET_CT_LEN, min, oi_delta, point, PRICE_BITS, SIZE_BITS, WAD,
};

global BATCH: u32 = 8;
global KEYS: u32 = 3;

struct Delta {
    is_short: Field,
    size: Field,
    remove: Field,
    ins_in: Field,
    claim: Field,
    rec_nonce: Field,
}

fn main(
    long_oi: Field,
    short_oi: Field,
    insurance: Field,
    bad_debt: Field,
    bond_used: Field,
    blind: Field,
    new_blind: Field,
    deltas: [Delta; BATCH],
    eph: [Field; KEYS],
    deployment: pub Field,
    market: pub Field,
    head: pub Field,
    new_head: pub Field,
    count: pub Field,
    delta_cm: pub [Field; BATCH],
    dt: pub Field,
    mark: pub Field,
    max_rate_wad: pub Field,
    index_mag: pub Field,
    index_neg: pub Field,
    claim_ratio: pub Field,
    bond_total: pub Field,
    keys: pub [[Field; 2]; KEYS],
    ct: pub [[Field; MARKET_CT_LEN]; KEYS],
) {
    if head == 0 {
        assert_eq(long_oi, 0, "fresh market has open interest");
        assert_eq(short_oi, 0, "fresh market has open interest");
        assert_eq(insurance, 0, "fresh market has insurance");
        assert_eq(bad_debt, 0, "fresh market has bad debt");
        assert_eq(bond_used, 0, "fresh market has used bond");
    } else {
        assert_eq(market_head(deployment, market, long_oi, short_oi, insurance, bad_debt, bond_used, blind), head, "head mismatch");
    }
    assert_amount(long_oi);
    assert_amount(short_oi);
    assert_amount(insurance);
    assert_amount(bad_debt);
    assert_amount(bond_total);
    assert(!bond_total.lt(bond_used), "bond overdrawn");
    dt.assert_max_bit_size::<16>();
    mark.assert_max_bit_size::<PRICE_BITS>();
    max_rate_wad.assert_max_bit_size::<64>();

    let total = long_oi + short_oi;
    let (mag, neg) = if total == 0 {
        (0, 0)
    } else {
        let up = !long_oi.lt(short_oi);
        let diff = if up { long_oi - short_oi } else { short_oi - long_oi };
        let skew = floor_div(diff * WAD, total);
        let rate = floor_div(floor_div(max_rate_wad, 3600) * skew, WAD);
        let idx = floor_div(rate * dt * mark, WAD);
        (idx, if up { 0 } else { 1 })
    };
    assert_eq(index_mag, mag, "wrong index change");
    assert_eq(index_neg, neg, "wrong index direction");

    count.assert_max_bit_size::<4>();
    let n = count as u32;
    assert(n <= BATCH, "batch too large");
    let mut long_next = long_oi;
    let mut short_next = short_oi;
    let mut inflow = 0;
    let mut claims = 0;
    for i in 0..BATCH {
        if i < n {
            let d = deltas[i];
            assert(d.is_short * (d.is_short - 1) == 0, "side is 0 or 1");
            assert(d.remove * (d.remove - 1) == 0, "remove is 0 or 1");
            d.size.assert_max_bit_size::<SIZE_BITS>();
            assert_amount(d.ins_in);
            assert_amount(d.claim);
            assert_eq(oi_delta(deployment, market, d.is_short, d.size, d.remove, d.ins_in, d.claim, d.rec_nonce), delta_cm[i], "bad delta opening");
            inflow += d.ins_in;
            claims += d.claim;
            if d.is_short == 0 {
                if d.remove == 0 {
                    long_next += d.size;
                } else {
                    assert(!long_next.lt(d.size), "open interest underflow");
                    long_next -= d.size;
                }
            } else if d.remove == 0 {
                short_next += d.size;
            } else {
                assert(!short_next.lt(d.size), "open interest underflow");
                short_next -= d.size;
            }
        } else {
            assert_eq(delta_cm[i], 0, "unused delta slot");
        }
    }
    assert_amount(long_next);
    assert_amount(short_next);

    let insurance_in = insurance + inflow;
    let available = insurance_in + bond_total - bond_used;
    let ratio = if claims == 0 { WAD } else { floor_div(min(available, claims) * WAD, claims) };
    assert_eq(claim_ratio, ratio, "wrong claim ratio");
    let mut paid = 0;
    for i in 0..BATCH {
        if i < n {
            paid += floor_div(deltas[i].claim * ratio, WAD);
        }
    }
    let from_insurance = min(paid, insurance_in);
    let insurance_next = insurance_in - from_insurance;
    let bond_used_next = bond_used + paid - from_insurance;
    let bad_debt_next = bad_debt + claims - paid;
    assert_amount(insurance_next);
    assert_amount(bad_debt_next);
    assert_eq(market_head(deployment, market, long_next, short_next, insurance_next, bad_debt_next, bond_used_next, new_blind), new_head);
    for i in 0..KEYS {
        assert_eq(encrypt([long_next, short_next, insurance_next, bad_debt_next, bond_used_next, new_blind], point(keys[i][0], keys[i][1]), eph[i]), ct[i]);
    }
}
