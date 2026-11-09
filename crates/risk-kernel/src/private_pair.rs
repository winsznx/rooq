//! Reference model of private pair settlement (docs/privacy/DECISION_LOG.md D-03, D-10, D-11, ADR-P05).
//!
//! Built on the signed helpers that `contracts/test/RiskParity.t.sol` holds equal to RiskMath.sol. The circuits and
//! the wallet SDK work in direction-plus-magnitude form instead, so an agreement between them is a real check.

use crate::{fee, funding_owed, margin_requirement, pnl_floor, pnl_trunc, BPS, WAD};
use ethnum::{I256, U256};

#[derive(Clone, Copy, Debug)]
pub struct PrivatePair {
    /// Taker exposure: positive long, negative short.
    pub size: I256,
    pub entry: U256,
    pub funding_snapshot: I256,
    pub taker_margin: U256,
    pub maker_margin: U256,
    pub close_spread_bps: U256,
    /// Funding carried from an earlier settlement: positive when the taker owes it.
    pub funding_debt: I256,
}

#[derive(Clone, Copy, Debug)]
pub struct FundingReceipt {
    pub owed: U256,
    pub paid: U256,
    pub netted: U256,
    pub written_off: U256,
}

struct AfterFunding {
    taker_pays: bool,
    taker_margin: U256,
    maker_margin: U256,
    owed: U256,
    paid: U256,
    unpaid: U256,
}

fn settle_funding(p: &PrivatePair, index: I256, scale: U256) -> AfterFunding {
    let signed = funding_owed(p.size, index - p.funding_snapshot, scale) + p.funding_debt;
    let taker_pays = signed > 0;
    let owed = signed.unsigned_abs();
    let paid = owed.min(if taker_pays { p.taker_margin } else { p.maker_margin });
    let (taker_margin, maker_margin) = if taker_pays {
        (p.taker_margin - paid, p.maker_margin + paid)
    } else {
        (p.taker_margin + paid, p.maker_margin - paid)
    };
    AfterFunding { taker_pays, taker_margin, maker_margin, owed, paid, unpaid: owed - paid }
}

/// Transfer owed to the taker (positive) or maker (negative), after unpaid funding is taken from the payer's gain.
fn net_transfer(f: &AfterFunding, trunc: I256) -> (I256, U256) {
    let payer_gains = if f.taker_pays { trunc > 0 } else { trunc < 0 };
    let netted = if payer_gains { trunc.unsigned_abs().min(f.unpaid) } else { U256::ZERO };
    let magnitude = (trunc.unsigned_abs() - netted).as_i256();
    (if trunc > 0 { magnitude } else { -magnitude }, netted)
}

#[derive(Clone, Copy, Debug)]
pub struct LiquidationOutcome {
    pub taker_bad: bool,
    pub maker_bad: bool,
    pub taker_out: U256,
    pub maker_out: U256,
    pub penalty: U256,
    pub reward: U256,
    pub to_insurance: U256,
    /// Shortfall the winner claims from insurance, paid at the epoch's ratio.
    pub claim: U256,
    pub funding: FundingReceipt,
}

pub fn liquidation_outcome(p: &PrivatePair, mark: U256, mmr_wad: U256, penalty_bps: U256, scale: U256, index: I256) -> LiquidationOutcome {
    let f = settle_funding(p, index, scale);
    let mm = margin_requirement(p.size.unsigned_abs(), mark, mmr_wad, scale).as_i256();
    let taker_debit = if f.taker_pays { f.unpaid.as_i256() } else { I256::ZERO };
    let maker_debit = if f.taker_pays { I256::ZERO } else { f.unpaid.as_i256() };
    let taker_bad = f.taker_margin.as_i256() + pnl_floor(p.size, p.entry, mark, scale) - taker_debit < mm;
    let maker_bad = f.maker_margin.as_i256() + pnl_floor(-p.size, p.entry, mark, scale) - maker_debit < mm;

    let (transfer, netted) = net_transfer(&f, pnl_trunc(p.size, p.entry, mark, scale));
    let owed = transfer.unsigned_abs();
    let available = if transfer > 0 { f.maker_margin } else { f.taker_margin };
    let paid = owed.min(available);
    let shortfall = owed - paid;
    let (mut taker_out, mut maker_out) = if transfer > 0 {
        (f.taker_margin + paid, f.maker_margin - paid)
    } else {
        (f.taker_margin - paid, f.maker_margin + paid)
    };

    let base = fee(p.size.unsigned_abs(), mark, penalty_bps, scale);
    let penalty = if taker_bad {
        let x = base.min(taker_out);
        taker_out -= x;
        x
    } else {
        let x = base.min(maker_out);
        maker_out -= x;
        x
    };
    let reward = penalty / 2;
    assert_eq!(p.taker_margin + p.maker_margin, taker_out + maker_out + penalty, "liquidation must conserve value");
    LiquidationOutcome {
        taker_bad,
        maker_bad,
        taker_out,
        maker_out,
        penalty,
        reward,
        to_insurance: penalty - reward,
        claim: shortfall,
        funding: FundingReceipt { owed: f.owed, paid: f.paid, netted, written_off: f.unpaid - netted },
    }
}

#[derive(Clone, Copy, Debug)]
pub enum ClosePolicy {
    /// Mark less the maker's standing close spread.
    Taker,
    /// Matured forced exit at the mark.
    Mark,
    /// Dead oracle: settles at the entry price.
    Entry,
}

#[derive(Clone, Copy, Debug)]
pub struct CloseOutcome {
    pub fill: U256,
    pub taker_out: U256,
    pub maker_out: U256,
    pub short_paid: U256,
    pub fee: U256,
    pub funding: FundingReceipt,
}

fn taker_close_fill(p: &PrivatePair, mark: U256) -> U256 {
    if p.size > 0 {
        mark * (BPS - p.close_spread_bps) / BPS
    } else {
        let n = mark * (BPS + p.close_spread_bps);
        (n + BPS - 1) / BPS
    }
}

pub fn close_outcome(p: &PrivatePair, policy: ClosePolicy, mark: U256, scale: U256, index: I256, fee_bps: U256) -> CloseOutcome {
    let fill = match policy {
        ClosePolicy::Taker => taker_close_fill(p, mark),
        ClosePolicy::Mark => mark,
        ClosePolicy::Entry => p.entry,
    };
    let f = settle_funding(p, index, scale);
    let (transfer, netted) = net_transfer(&f, pnl_trunc(p.size, p.entry, fill, scale));
    let owed = transfer.unsigned_abs();
    let paid = owed.min(if transfer > 0 { f.maker_margin } else { f.taker_margin });
    let (taker_after, maker_out) = if transfer > 0 {
        (f.taker_margin + paid, f.maker_margin - paid)
    } else {
        (f.taker_margin - paid, f.maker_margin + paid)
    };
    let charged = match policy {
        ClosePolicy::Taker => fee(p.size.unsigned_abs(), fill, fee_bps, scale).min(taker_after),
        _ => U256::ZERO,
    };
    let taker_out = taker_after - charged;
    assert_eq!(p.taker_margin + p.maker_margin, taker_out + maker_out + charged, "close must conserve value");
    CloseOutcome {
        fill,
        taker_out,
        maker_out,
        fee: charged,
        short_paid: owed - paid,
        funding: FundingReceipt { owed: f.owed, paid: f.paid, netted, written_off: f.unpaid - netted },
    }
}

#[derive(Clone, Debug)]
pub struct EpochClaims {
    pub ratio: U256,
    pub payouts: Vec<U256>,
    pub insurance_next: U256,
    pub bad_debt_added: U256,
    pub bond_used_added: U256,
}

/// One epoch's batch: penalty shares arrive first, then every claim is paid the same ratio, from insurance and then the creator bond (D-07, D-22).
pub fn fold_claims(insurance: U256, inflow: U256, claims: &[U256], bond_left: U256) -> EpochClaims {
    let insurance_in = insurance + inflow;
    let available = insurance_in + bond_left;
    let total = claims.iter().fold(U256::ZERO, |a, c| a + *c);
    let ratio = if total == U256::ZERO { WAD } else { available.min(total) * WAD / total };
    let payouts: Vec<U256> = claims.iter().map(|c| *c * ratio / WAD).collect();
    let paid = payouts.iter().fold(U256::ZERO, |a, c| a + *c);
    assert!(paid <= available, "cannot pay more than insurance holds");
    let from_insurance = paid.min(insurance_in);
    EpochClaims { ratio, payouts, insurance_next: insurance_in - from_insurance, bad_debt_added: total - paid, bond_used_added: paid - from_insurance }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Actor {
    Nobody,
    Taker,
    Maker,
}

#[derive(Clone, Copy, Debug)]
pub struct UpdateRequest {
    pub actor: Actor,
    pub add: U256,
    pub remove: U256,
    pub reduce: U256,
}

#[derive(Clone, Copy, Debug)]
pub struct UpdateOutcome {
    /// The rule that blocks this update, in the order the circuit checks them.
    pub refused: Option<&'static str>,
    pub taker_margin: U256,
    pub maker_margin: U256,
    pub size: U256,
    pub fee: U256,
    /// Funding carried forward: positive when the taker owes it.
    pub funding_debt: I256,
    pub funding: FundingReceipt,
}

pub fn update_outcome(p: &PrivatePair, u: UpdateRequest, mark: U256, imr_wad: U256, scale: U256, index: I256, fee_bps: U256) -> UpdateOutcome {
    let f = settle_funding(p, index, scale);
    let fill = taker_close_fill(p, mark);
    let signed_reduce = if p.size > 0 { u.reduce.as_i256() } else { -u.reduce.as_i256() };
    let (transfer, netted) = net_transfer(&f, pnl_trunc(signed_reduce, p.entry, fill, scale));
    let unpaid = f.unpaid - netted;
    let funding_debt = if f.taker_pays { unpaid.as_i256() } else { -unpaid.as_i256() };
    let size = p.size.unsigned_abs() - u.reduce;
    let receipt = FundingReceipt { owed: f.owed, paid: f.paid, netted, written_off: U256::ZERO };
    let blocked = |refused, charged| UpdateOutcome {
        refused: Some(refused),
        taker_margin: U256::ZERO,
        maker_margin: U256::ZERO,
        size,
        fee: charged,
        funding_debt,
        funding: receipt,
    };

    let amount = transfer.unsigned_abs();
    if amount > (if transfer > 0 { f.maker_margin } else { f.taker_margin }) {
        return blocked("underwater pair cannot reduce", U256::ZERO);
    }
    let (taker_after, maker_after) = if transfer > 0 {
        (f.taker_margin + amount, f.maker_margin - amount)
    } else {
        (f.taker_margin - amount, f.maker_margin + amount)
    };
    let charged = fee(u.reduce, fill, fee_bps, scale).min(taker_after);
    let mut taker_margin = taker_after - charged;
    let mut maker_margin = maker_after;
    match u.actor {
        Actor::Taker => {
            taker_margin += u.add;
            if taker_margin < u.remove {
                return blocked("removal above margin", charged);
            }
            taker_margin -= u.remove;
        }
        Actor::Maker => {
            maker_margin += u.add;
            if maker_margin < u.remove {
                return blocked("removal above margin", charged);
            }
            maker_margin -= u.remove;
        }
        Actor::Nobody => {}
    }

    if u.remove > 0 {
        let im = margin_requirement(size, mark, imr_wad, scale).as_i256();
        let signed_size = if p.size > 0 { size.as_i256() } else { -size.as_i256() };
        let (own, counter, pnl, payer) = match u.actor {
            Actor::Taker => (taker_margin, maker_margin, pnl_floor(signed_size, p.entry, mark, scale), f.taker_pays),
            _ => (maker_margin, taker_margin, pnl_floor(-signed_size, p.entry, mark, scale), !f.taker_pays),
        };
        let certified = if pnl > 0 { pnl.min(counter.as_i256()) } else { pnl };
        let debit = if payer { unpaid.as_i256() } else { I256::ZERO };
        if own.as_i256() + certified - debit < im {
            return blocked("below initial margin", charged);
        }
    }
    UpdateOutcome { refused: None, taker_margin, maker_margin, size, fee: charged, funding_debt, funding: receipt }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USD: u128 = 1_000_000;
    const SCALE: U256 = U256::new(1_000_000_000_000);

    fn pair(size: i128, entry: u128, snapshot: i128, tm: u128, mm: u128) -> PrivatePair {
        PrivatePair {
            size: I256::new(size) * WAD.as_i256(),
            entry: U256::new(entry),
            funding_snapshot: I256::new(snapshot),
            taker_margin: U256::new(tm),
            maker_margin: U256::new(mm),
            close_spread_bps: U256::new(30),
            funding_debt: I256::ZERO,
        }
    }

    #[test]
    fn a_winning_payer_loses_its_gain_to_unpaid_funding() {
        // Long 3 from 100.2, marked at 101, owing 15 per unit against 31 of margin.
        let entry = 1002 * WAD.as_u128() / 10;
        let p = pair(3, entry, 0, 31 * USD, 100 * USD);
        let o = liquidation_outcome(&p, U256::new(101) * WAD, WAD / 20, U256::new(100), SCALE, I256::new(15) * WAD.as_i256());
        assert!(o.taker_bad);
        assert_eq!(o.taker_out, U256::ZERO);
        assert_eq!(o.maker_out, U256::new(131 * USD));
        assert_eq!(o.funding.netted, U256::new(2_400_000));
        assert_eq!(o.funding.written_off, U256::new(45 * USD - 31 * USD - 2_400_000));
    }

    #[test]
    fn carried_debt_is_collected_before_new_funding_credits_the_payer() {
        let mut p = pair(1, 100 * WAD.as_u128(), 0, 50 * USD, 60 * USD);
        p.funding_debt = I256::new((3 * USD) as i128);
        // The index fell by 1 per unit, so the long is owed 1 and still owes 3: it pays a net 2.
        let o = close_outcome(&p, ClosePolicy::Entry, U256::ZERO, SCALE, I256::new(-1) * WAD.as_i256(), U256::ZERO);
        assert_eq!((o.taker_out, o.maker_out), (U256::new(48 * USD), U256::new(62 * USD)));
    }

    #[test]
    fn removal_is_blocked_below_initial_margin_and_gains_count_only_to_counterparty_margin() {
        let p = pair(1, 100 * WAD.as_u128(), 0, 15 * USD, 1 * USD);
        let u = UpdateRequest { actor: Actor::Taker, add: U256::ZERO, remove: U256::new(5 * USD), reduce: U256::ZERO };
        // At 150 the taker's gain of 50 is backed by only 1 of maker margin, and initial margin is 15.
        let o = update_outcome(&p, u, U256::new(150) * WAD, WAD / 10, SCALE, I256::ZERO, U256::ZERO);
        assert_eq!(o.refused, Some("below initial margin"));
    }

    #[test]
    fn claims_in_one_epoch_share_insurance_pro_rata_regardless_of_order() {
        let a = fold_claims(U256::new(60), U256::new(40), &[U256::new(150), U256::new(50)], U256::ZERO);
        let b = fold_claims(U256::new(60), U256::new(40), &[U256::new(50), U256::new(150)], U256::ZERO);
        assert_eq!(a.ratio, WAD / 2);
        assert_eq!((a.payouts[0], a.payouts[1]), (b.payouts[1], b.payouts[0]));
        assert_eq!(a.insurance_next, U256::ZERO);
        assert_eq!(a.bad_debt_added, U256::new(100));
    }

    #[test]
    fn insurance_is_spent_before_the_creator_bond() {
        let e = fold_claims(U256::new(30), U256::ZERO, &[U256::new(50)], U256::new(100));
        assert_eq!(e.ratio, WAD);
        assert_eq!((e.insurance_next, e.bond_used_added, e.bad_debt_added), (U256::ZERO, U256::new(20), U256::ZERO));
    }

    #[test]
    fn dead_oracle_settlement_moves_only_funding() {
        let p = pair(2, 100 * WAD.as_u128(), 0, 50 * USD, 60 * USD);
        let o = close_outcome(&p, ClosePolicy::Entry, U256::ZERO, SCALE, I256::new(1) * WAD.as_i256(), U256::new(10));
        assert_eq!((o.taker_out, o.maker_out), (U256::new(48 * USD), U256::new(62 * USD)));
    }

    #[test]
    fn a_loser_that_cannot_pay_short_pays_only_its_counterparty() {
        let p = pair(1, 100 * WAD.as_u128(), 0, 10 * USD, 60 * USD);
        let o = close_outcome(&p, ClosePolicy::Mark, U256::new(50) * WAD, SCALE, I256::ZERO, U256::new(10));
        assert_eq!((o.taker_out, o.maker_out, o.short_paid), (U256::ZERO, U256::new(70 * USD), U256::new(40 * USD)));
    }
}
