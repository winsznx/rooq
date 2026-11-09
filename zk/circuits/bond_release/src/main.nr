// Shows that a closed market has no open positions and how much of its creator bond was used to cover shortfalls, so the
// contract can return the rest to the creator (MARKET-03). Reveals only the used amount.
use rooq_zk::market_head;

fn main(
    insurance: Field,
    bad_debt: Field,
    blind: Field,
    deployment: pub Field,
    market: pub Field,
    head: pub Field,
    bond_used: pub Field,
) {
    assert_eq(market_head(deployment, market, 0, 0, insurance, bad_debt, bond_used, blind), head, "open positions or wrong record");
}
