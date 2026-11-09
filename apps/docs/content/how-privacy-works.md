Rooq keeps your balance, positions and trades out of public view. It doesn't hide everything, and it isn't anonymity. This page says exactly where the line is.

## The short version

Your device holds your keys and makes your proofs. The chain only sees commitments, proofs and encrypted data. A proof shows that a trade follows the rules without showing the trade.

Pick someone below to see Rooq from where they stand.

```slot:lens
```

## What can still link you

Some things can't be hidden, and some patterns give you away.

- **Moving in and out is public.** Shielding and unshielding show the address, token, amount and time.
- **Distinctive amounts.** Shielding 1,337.42 USDG and unshielding the same amount later looks like one person.
- **Fast round trips.** Shielding and unshielding close together links the two.
- **Thin markets.** In a market with few trades, public totals and timing can reveal a single trade. A funding index with one position open reveals that position's direction.
- **Address reuse.** Shielding and unshielding with the same wallet ties them together.
- **Gas funding.** Paying gas for an unshield from your connected wallet links it publicly.
- **Your device.** Rooq can't protect you if your device or browser is compromised.
- **Your network.** The services you connect to can see your IP address. A rate limit holds it in memory for a minute and Rooq's services don't log it. If that matters to you, use a VPN or Tor.

Rooq never falls back to public execution. If proving fails or a service is down, your action stops or refunds. It doesn't quietly go public.

## Published market data

Rooq publishes no trade feed. There's no list of individual trades, sizes or accounts.

Market totals are published per hour and rounded to two significant figures. An hour is only published if it has at least 10 fills, at least 2 makers and no single fill above 25% of its volume. An hour that fails rolls into the next one.

This limits what a release can say about one trade. It can't stop a determined person who splits orders across many accounts, because Rooq can't tell who is behind a note.

## Who the services are

- **Coordinator.** Matches locks and fills spot requests. It can only do what your signed limits allow.
- **Risk workers.** Two services with separate keys. They read positions so liquidation works when you're offline.
- **Relayer.** Pays gas and submits proofs. It holds no secrets and can't sign for you.

These services can see what's listed above. If one of them keeps or leaks what it has read, proofs can't undo that, and changing keys later can't erase what it learned.

None of them can move your money outside the rules. The contracts and proofs check custody and math, even if every service were dishonest. A service can still delay or refuse to act. The testnet price relay is a separate case. It can set any price within its bounds, and a bad price can cause real losses in a position.

## How to verify it

Anyone can check that an action was accepted against the [public contracts](/contracts). The explorer shows that a proof was accepted. It doesn't show your trade, and your receipt in the app is what holds the details.

Rooq has not been audited. This page describes the design and the code.
