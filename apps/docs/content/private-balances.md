Your private balance is a set of encrypted notes held by one shared contract. Each note says who owns it and how much it's worth. Only your device can read yours.

## Shield: public to private

Shielding sends tokens from your public wallet to the Rooq contract and creates a private note for you.

Tokens enter a queue first. Once the queue is processed, usually within a block or two, the note is yours to spend. Only supported tokens can be shielded.

```who-sees
Public chain | Your wallet, the token, the amount and the time
Your maker | - Only what the public can see
Risk workers | - Only what the public can see
You | Everything
```

The link between this deposit and your later activity stays hidden. Distinctive amounts and quick withdrawals can still give it away. See [how privacy works](/how-privacy-works#what-can-still-link-you).

## Send privately

A private transfer moves tokens to another Rooq account. You need their private address, and you can find yours in the app. The amount, the token and both people stay hidden.

A relayer pays the gas for you, so your public wallet isn't involved. On networks where it charges a fee, the fee is a small private note and the app shows it before you confirm.

```who-sees
Public chain | - That a private spend happened. Not the amount, the token or either person
Relayer | Its own fee note, and the proof it submits
Recipient | The amount and token they received
You | Everything
```

## Unshield: private to public

Unshielding sends tokens from your private balance to a public address that you choose. You can only unshield your free balance. Margin in a position, maker backing and liquidity in a pool have to be released first.

You can choose who pays the gas.

- **Relayer pays.** Your wallet isn't involved. The app shows any fee first.
- **My wallet pays.** Your connected wallet sends the transaction, which publicly links that wallet to this unshield.

```who-sees
Public chain | The recipient, the token, the amount and the time
Risk workers | - Only what the public can see
You | Everything
```

Your private history and the link to your other activity stay hidden. The address you send to is public forever, so choose it with that in mind.

If the relayer is down, you can still unshield by paying the gas from your own wallet.

## Combine notes

Every action can spend at most two notes at once. If your balance is spread across many small notes, a larger trade can't be paid in one step. The **Combine** button in your portfolio merges your notes for that token into one.

## Balances the app can show you

- **Free** is what you can trade, send or unshield now.
- **Locked** is committed to an open lock, such as a trade waiting for a maker. It comes back if the lock expires.
- **In a position** is margin backing an open position.

Rooq reads your balance from chain data and decrypts it on your device. If the data isn't available, the app shows **Unavailable** rather than zero.
