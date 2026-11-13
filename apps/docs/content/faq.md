## The basics

### What is Rooq?

Rooq is a place to trade stock tokens privately on Robinhood Chain testnet. You can swap tokens on spot or trade their price with leverage on perps.

### Is this real money?

No. Rooq runs on testnet. Test tokens have no value, and you can't turn them into money.

### Is Rooq audited?

No. Rooq has not been audited. The contracts, circuits and services may have bugs.

### Is Rooq part of Robinhood?

No. Rooq is an independent project that runs on Robinhood Chain. Robinhood doesn't run it or endorse it.

### Do Stock Tokens give me shares?

No. A Stock Token gives you price exposure. It doesn't give you shares, votes or dividends.

### Why does this exist?

Trading on a public chain shows your balance, positions and history to everyone. Rooq keeps those private, while anyone can still check that every trade followed the rules.

## Privacy

### Is Rooq anonymous?

No. Rooq hides your balances, positions and trades from the public, but it isn't anonymous. Moving tokens in and out is public, and some services can see parts of your activity.

### Is it untraceable?

No. Shields and unshields are public. Timing and amounts can link them to you, especially in quiet markets.

### Who can see my position?

You can, your maker can, and the risk workers can see what they need to liquidate it. The coordinator sees the terms of your lock against a one-time address. The public can't. [How privacy works](/how-privacy-works) has the full breakdown.

### Can my maker see who I am?

Your maker sees your position, against a one-time address. It doesn't see your wallet or the rest of your account. A taker can't see which maker backs its position.

### Why can a risk service see my position?

Liquidation has to work when you're offline. Hidden positions can't be found by just anyone, so two risk workers can read what they need. They can only close a position that's below maintenance, inside fixed rules.

### Why is my deposit public?

The token moves on a public chain, so the transfer is visible. What happens after it enters your private balance isn't.

### What stops someone from linking my deposit and withdrawal?

Rooq hides the link inside the system. You still have to avoid giving it away. Use different amounts, wait between them, and don't use the same wallet for both.

## Getting started

### What do I need?

A browser wallet, test ETH for gas and test tokens. [Getting started](/getting-started) walks through it.

### Where do I get test tokens?

The [Robinhood Chain faucet](https://faucet.testnet.chain.robinhood.com) has test ETH and Stock Tokens. The [Paxos faucet](https://faucet.paxos.com) has USDG: pick Robinhood Chain testnet and paste your wallet address. Both are free.

### What's the difference between my wallet and my private account?

Your wallet is your public address on the chain. Your private account holds your private balance, and it's derived from one signature by your wallet. Nothing on the chain links the two.

### Do I need to back up a seed phrase?

No, in most cases. If your wallet can sign the same message the same way twice, the same wallet restores your account on any device. Some smart-contract and multi-party wallets can't, so those use a passkey or a generated 24-word phrase, which you do need to keep safe.

### Is signing the message safe?

Only sign it on Rooq. Anyone who gets that same signature gets your private account. It costs no gas and it sends nothing to a server.

### What if I lose my wallet?

Your private account goes with it, unless you also set up a passkey or a generated phrase. Nobody can recover it for you.

### What if I lose my device?

Connect your wallet on another device and sign again. Rooq rebuilds your account from chain data.

### Why does it take a few seconds?

Your browser makes a proof before anything is sent. That's the work that keeps your trade private.

## Trading

### Is there an order book?

No. Perps match your private lock with a maker's standing offer. Spot trades against pools.

### What leverage can I use?

Each market sets its own. The five testnet markets allow up to 2x. The ticket always shows the limit.

### What fees do I pay?

0.06% on perps fills and 0.30% per pool on spot, on testnet. Funding moves between traders. A relayer may charge a small fee, and the app shows it first. See [Funding and fees](/funding-and-fees).

### What happens if no maker matches me?

Your lock expires and your margin comes back.

### Can I lose more than my margin?

No. A loss can't take more than the margin in that position. You can lose all of it.

### Why was my position liquidated?

Its margin fell below maintenance at the oracle price. Your receipt shows the price, the penalty and what came back.

### Can my maker stop me from closing?

No. You can close alone, at any time, against the spread your maker committed to at open. A close does need a fresh price.

### Can Rooq pause my withdrawals?

No. The contracts have no pause on private positions or balances, and no admin function that moves funds.

### What if the price feed stops?

New positions, closes and liquidations wait for a fresh price. If it stays dead for 14 days, a matured forced exit settles at the entry price.

### Can I get my tokens out if Rooq goes away?

Your free balance doesn't depend on Rooq's services. You can unshield with your own wallet as long as the chain is running. [Recovery](/recovery) covers each case.

## Building

### Is there an API?

Yes. [API and SDK](/api-and-sdk) covers the private read API, the relayer and the TypeScript SDK.

### Where are the contracts?

The [Contracts](/contracts) page lists them and shows how to check them yourself.
