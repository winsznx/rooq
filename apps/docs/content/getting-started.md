## What you need

You need a browser wallet, some test ETH for gas, and test tokens to trade. Everything here is on Robinhood Chain testnet, chain ID 46630.

## 1. Connect your wallet

Open [Rooq]({{app_url}}), choose **Connect wallet** and pick your wallet from the list. If it's on the wrong network, Rooq asks you to switch before you can sign anything.

Connecting your wallet doesn't publish anything. Nothing on the chain links your wallet to your private account. Shielding shows that your wallet deposited tokens, but not which private notes are yours.

## 2. Get test funds

Test funds have no value. You get them from public faucets.

- **Test ETH** pays for gas on your public transactions. Get it from the [Robinhood Chain faucet](https://faucet.testnet.chain.robinhood.com).
- **USDG** is the token used for margin and spot trades. Get it from the [Paxos testnet guide](https://docs.paxos.com/guides/stablecoin/usdg/testnet).
- **Stock Tokens** are TSLA, AMZN, PLTR, NFLX and AMD on testnet. The faucets above supply them. Check any token against the addresses on the [Contracts](/contracts) page, because copycat tokens with the same ticker exist on this chain.

## 3. Create your private account

Your private account comes from your wallet. Sign one fixed message in your wallet, and Rooq derives your account's keys from that signature in your browser. No server ever receives the signature or the keys, and signing costs no gas.

Nothing extra to back up. The same wallet opens the same account on any device. Your account's keys are only held in memory while it's open.

> Only sign this message on Rooq. A phishing site that gets the same signature gets your private account.

Whoever controls your wallet controls your private account. Keep your wallet safe.

### Remember this device

You can skip the wallet signature next time by remembering this device. Rooq stores your account encrypted, under a passkey where your browser supports one, or under a key that can't leave this browser. It's never stored in plain text.

### Wallets that can't sign the same way twice

Some smart-contract and multi-party wallets return a different signature each time, and those can't derive a stable key. Rooq checks for this at setup. If your wallet is one of them, use a passkey-derived account or a generated 24-word recovery phrase instead.

If you use a generated phrase, write the 24 words down, in order, somewhere offline. Anyone who has them can spend your account, and nobody can recover them for you.

## 4. Shield tokens

Shielding moves tokens from your public wallet into your private balance. Choose **Shield**, pick a token and an amount, then confirm in your wallet.

The shield itself is public. Anyone can see the wallet, the token and the amount. What happens next with those tokens is not.

Your tokens show up in your private balance once the queue is processed, usually within a block or two.

## 5. Make your first trade

You're ready. Try a small [spot swap](/spot) first, then read [Perps](/perps) before you use leverage.

Every private action makes a proof in your browser, which can take a little while on a slower device. The operation center tracks each step, and you can keep using the app while it runs.

## What to keep safe

If you signed with your wallet, keep your wallet safe and you can restore your private account on any device. If you use a passkey or a generated recovery phrase, keep those safe instead. [Recovery](/recovery) explains what you can get back and how.
