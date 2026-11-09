//! Reference state machine for one taker/maker pair, mirroring `ClearingHouse.sol`.
//!
//! It tracks the same ledger entries the MarginVault holds for the pair (taker free, taker margin,
//! maker margin, maker commitment, protocol fees) so a test can assert that the total never changes
//! except through explicit deposits.

use crate::*;
use ethnum::{I256, U256};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Risk {
    pub imr_wad: U256Str,
    pub mmr_wad: U256Str,
    pub taker_fee_bps: u16,
    pub max_funding_rate_per_hour_wad: U256Str,
    pub scale: U256Str,
}

/// Decimal string wrapper so 256-bit values survive JSON round trips into Foundry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct U256Str(pub U256);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct I256Str(pub I256);

impl Serialize for U256Str {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_string())
    }
}
impl<'de> Deserialize<'de> for U256Str {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        U256::from_str_radix(&s, 10).map(U256Str).map_err(serde::de::Error::custom)
    }
}
impl Serialize for I256Str {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_string())
    }
}
impl<'de> Deserialize<'de> for I256Str {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        I256::from_str_radix(&s, 10).map(I256Str).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Step {
    /// Taker fills `size` at `price` (mark = `mark`), depositing `margin` from free balance.
    Trade { size: I256Str, price: U256Str, mark: U256Str, margin: U256Str },
    /// Advance time and refresh the mark (accrual happens on the next touch, like onchain).
    Warp { seconds: u64, mark: U256Str },
    /// Permissionless funding settlement at the current mark.
    SettleFunding { mark: U256Str },
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    pub taker_free: U256Str,
    pub taker_margin: U256Str,
    pub maker_margin: U256Str,
    pub maker_commit: U256Str,
    pub fees: U256Str,
}

impl Ledger {
    pub fn total(&self) -> U256 {
        self.taker_free.0 + self.taker_margin.0 + self.maker_margin.0 + self.maker_commit.0 + self.fees.0
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairState {
    pub size: I256Str,
    pub entry_price: U256Str,
    pub funding_index: I256Str,
    pub funding_snapshot: I256Str,
    pub long_oi: U256Str,
    pub short_oi: U256Str,
    pub realized_pnl: I256Str,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SimError {
    MarginTooLow { equity: I256, required: U256 },
    MakerCapacityExhausted,
    InsufficientMarginForSettlement,
    FlipNotAllowed,
}

pub struct PairSim {
    pub risk: Risk,
    pub ledger: Ledger,
    pub state: PairState,
    now: u64,
    last_funding_time: u64,
}

impl PairSim {
    pub fn new(risk: Risk, taker_free: U256, maker_commit: U256, start: u64) -> Self {
        let ledger = Ledger {
            taker_free: U256Str(taker_free),
            maker_commit: U256Str(maker_commit),
            ..Default::default()
        };
        Self { risk, ledger, state: PairState::default(), now: start, last_funding_time: 0 }
    }

    fn scale(&self) -> U256 {
        self.risk.scale.0
    }

    fn accrue(&mut self, mark: U256) {
        if self.last_funding_time == self.now {
            return;
        }
        let last = self.last_funding_time;
        self.last_funding_time = self.now;
        if last == 0 {
            return;
        }
        let rate = funding_rate_per_second(
            self.state.long_oi.0,
            self.state.short_oi.0,
            self.risk.max_funding_rate_per_hour_wad.0,
        );
        if rate == I256::ZERO {
            return;
        }
        // Mirrors ClearingHouse.MAX_FUNDING_WINDOW: at most one hour accrues per touch.
        let dt = (self.now - last).min(3600);
        let delta = funding_index_delta(rate, U256::from(dt), mark);
        self.state.funding_index = I256Str(self.state.funding_index.0 + delta);
    }

    fn settle_funding(&mut self) {
        let idx = self.state.funding_index.0;
        let delta = idx - self.state.funding_snapshot.0;
        self.state.funding_snapshot = I256Str(idx);
        if delta == I256::ZERO || self.state.size.0 == I256::ZERO {
            return;
        }
        let owed = funding_owed(self.state.size.0, delta, self.scale());
        let amount = abs(owed);
        // The reference vectors stay solvent, so the payer always covers the full amount here.
        if owed > I256::ZERO {
            let paid = amount.min(self.ledger.taker_margin.0);
            self.ledger.taker_margin.0 -= paid;
            self.ledger.maker_margin.0 += paid;
        } else if owed < I256::ZERO {
            let paid = amount.min(self.ledger.maker_margin.0);
            self.ledger.maker_margin.0 -= paid;
            self.ledger.taker_margin.0 += paid;
        }
    }

    fn certified(margin: U256, pnl: I256, counterparty: U256) -> I256 {
        let capped = if pnl > I256::ZERO && abs(pnl) > counterparty { to_i(counterparty) } else { pnl };
        to_i(margin) + capped
    }

    pub fn apply(&mut self, step: &Step) -> Result<(), SimError> {
        match step {
            Step::Warp { seconds, .. } => {
                self.now += seconds;
                Ok(())
            }
            Step::SettleFunding { mark } => {
                self.accrue(mark.0);
                self.settle_funding();
                Ok(())
            }
            Step::Trade { size, price, mark, margin } => self.trade(size.0, price.0, mark.0, margin.0),
        }
    }

    fn trade(&mut self, fill: I256, price: U256, mark: U256, margin_deposit: U256) -> Result<(), SimError> {
        let s = self.state.size.0;
        let increase = s == I256::ZERO || (s > I256::ZERO) == (fill > I256::ZERO);
        if !increase && abs(fill) > abs(s) {
            return Err(SimError::FlipNotAllowed);
        }
        self.accrue(mark);
        if s != I256::ZERO {
            self.settle_funding();
        }
        let scale = self.scale();
        if increase {
            if s == I256::ZERO {
                self.state.entry_price = U256Str(price);
                self.state.funding_snapshot = self.state.funding_index;
            } else {
                self.state.entry_price =
                    U256Str(weighted_entry(abs(s), self.state.entry_price.0, abs(fill), price));
            }
            self.state.size = I256Str(s + fill);
            self.ledger.taker_free.0 -= margin_deposit;
            self.ledger.taker_margin.0 += margin_deposit;
            if fill > I256::ZERO {
                self.state.long_oi.0 += abs(fill);
            } else {
                self.state.short_oi.0 += abs(fill);
            }
            let size = self.state.size.0;
            let entry = self.state.entry_price.0;
            let im = margin_requirement(abs(size), mark, self.risk.imr_wad.0, scale);
            let e_m = Self::certified(self.ledger.maker_margin.0, pnl_floor(-size, entry, mark, scale), self.ledger.taker_margin.0);
            if e_m < to_i(im) {
                let need = abs(to_i(im) - e_m);
                if self.ledger.maker_commit.0 < need {
                    return Err(SimError::MakerCapacityExhausted);
                }
                self.ledger.maker_commit.0 -= need;
                self.ledger.maker_margin.0 += need;
            }
            let e_t = Self::certified(self.ledger.taker_margin.0, pnl_floor(size, entry, mark, scale), self.ledger.maker_margin.0);
            if e_t < to_i(im) {
                return Err(SimError::MarginTooLow { equity: e_t, required: im });
            }
        } else {
            let realized = pnl_trunc(-fill, self.state.entry_price.0, price, scale);
            let owed = abs(realized);
            if realized > I256::ZERO {
                if owed > self.ledger.maker_margin.0 {
                    return Err(SimError::InsufficientMarginForSettlement);
                }
                self.ledger.maker_margin.0 -= owed;
                self.ledger.taker_margin.0 += owed;
            } else if realized < I256::ZERO {
                if owed > self.ledger.taker_margin.0 {
                    return Err(SimError::InsufficientMarginForSettlement);
                }
                self.ledger.taker_margin.0 -= owed;
                self.ledger.maker_margin.0 += owed;
            }
            self.state.realized_pnl = I256Str(self.state.realized_pnl.0 + realized);
            self.state.size = I256Str(s + fill);
            if s > I256::ZERO {
                self.state.long_oi.0 -= abs(fill);
            } else {
                self.state.short_oi.0 -= abs(fill);
            }
            if self.state.size.0 == I256::ZERO {
                self.ledger.taker_free.0 += self.ledger.taker_margin.0;
                self.ledger.taker_margin.0 = U256::ZERO;
                self.ledger.maker_commit.0 += self.ledger.maker_margin.0;
                self.ledger.maker_margin.0 = U256::ZERO;
                self.state.entry_price = U256Str(U256::ZERO);
                self.state.funding_snapshot = I256Str(I256::ZERO);
                self.state.realized_pnl = I256Str(I256::ZERO);
            } else {
                let size = self.state.size.0;
                let im = margin_requirement(abs(size), mark, self.risk.imr_wad.0, scale);
                let e_m = to_i(self.ledger.maker_margin.0) + pnl_floor(-size, self.state.entry_price.0, mark, scale);
                if e_m > to_i(im) {
                    let excess = abs(e_m - to_i(im)).min(self.ledger.maker_margin.0);
                    self.ledger.maker_margin.0 -= excess;
                    self.ledger.maker_commit.0 += excess;
                }
            }
        }
        let f = fee(abs(fill), price, U256::from(self.risk.taker_fee_bps), scale);
        self.ledger.taker_free.0 -= f;
        self.ledger.fees.0 += f;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn risk() -> Risk {
        Risk {
            imr_wad: U256Str(WAD / 2),
            mmr_wad: U256Str(U256::new(350_000_000_000_000_000)),
            taker_fee_bps: 6,
            max_funding_rate_per_hour_wad: U256Str(U256::new(100_000_000_000_000)),
            scale: U256Str(U256::new(1_000_000_000_000)),
        }
    }

    fn p(x: u128) -> U256Str {
        U256Str(U256::new(x) * WAD)
    }

    #[test]
    fn lifecycle_conserves_ledger() {
        let mut sim = PairSim::new(risk(), U256::new(50_000_000_000), U256::new(300_000_000_000), 1_800_000_000);
        let total = sim.ledger.total();
        let steps = [
            Step::Trade { size: I256Str(I256::new(200_000_000_000_000_000)), price: p(60_000), mark: p(60_000), margin: U256Str(U256::new(8_000_000_000)) },
            Step::Warp { seconds: 1800, mark: p(61_000) },
            Step::Trade { size: I256Str(I256::new(-50_000_000_000_000_000)), price: p(61_000), mark: p(61_000), margin: U256Str(U256::ZERO) },
            Step::Warp { seconds: 3000, mark: p(59_000) },
            Step::SettleFunding { mark: p(59_000) },
            Step::Trade { size: I256Str(I256::new(-150_000_000_000_000_000)), price: p(59_000), mark: p(59_000), margin: U256Str(U256::ZERO) },
        ];
        for s in &steps {
            sim.apply(s).expect("valid step");
            assert_eq!(sim.ledger.total(), total, "no step creates or destroys collateral");
        }
        assert_eq!(sim.state.size.0, I256::ZERO);
        assert_eq!(sim.ledger.taker_margin.0, U256::ZERO);
        assert_eq!(sim.ledger.maker_margin.0, U256::ZERO);
    }

    #[test]
    fn rejects_under_margined_open() {
        let mut sim = PairSim::new(risk(), U256::new(50_000_000_000), U256::new(300_000_000_000), 1);
        let err = sim
            .apply(&Step::Trade { size: I256Str(I256::new(200_000_000_000_000_000)), price: p(60_000), mark: p(60_000), margin: U256Str(U256::new(5_999_000_000)) })
            .unwrap_err();
        assert_eq!(err, SimError::MarginTooLow { equity: I256::new(5_999_000_000), required: U256::new(6_000_000_000) });
    }
}
