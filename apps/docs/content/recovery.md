Your funds are in the contract, not your browser. What you need to reach them depends on how your account was created.

## Restoring your account

How you get back in depends on how the account was created. These are two different accounts, not two keys to the same one.

- **Signed with your wallet.** Connect the same wallet and sign the same message on any device. Rooq derives the same account every time.
- **Passkey account.** If you chose "Create a passkey account", your account comes from that passkey. Use the same synced passkey on a new device and choose "Use an existing passkey". Signing with your wallet instead opens a different, empty account.

Rooq then rebuilds your notes, positions and receipts from chain data. Nothing else is needed. If you have a long history, this can take a while.

This works for anything that happened while you were away, including funding, liquidations and forced closes. Encrypted results are written to the chain for you to find.

## What each secret does

| Secret | What it does | If you lose it |
| --- | --- | --- |
| Your wallet | Derives a wallet-signature account with one signature | That account is gone with it |
| Passkey account | Derives a passkey account, separate from your wallet-signature account | That account is gone with it |
| Remembered device | Unlocks an account you already opened, on this browser only | Nothing is lost. Sign or use your passkey again |

Whoever controls the wallet or passkey behind an account controls it. Rooq can't freeze, reverse or recover anything.

## Lost device

Your funds stay in the contract. Restore on another device with the method above. An open position stays exposed to the market while you're away, and it can be liquidated.

If you think someone else has your wallet or passkey, open the account on a clean device right away and move your funds to a new account with a private transfer.

## Remembered devices

Remembering a device stores your account encrypted, under a passkey or a key that can't leave that browser. **Forget on this browser** removes that copy. Your funds aren't touched, and you can sign with your wallet to open the account again.

## When Rooq's services are down

| What's down | What still works |
| --- | --- |
| Relayer | Unshielding, if your wallet pays the gas |
| Coordinator | Your locks expire and refund. Nothing new matches |
| Risk workers | Positions aren't liquidated until one is back. Your margin can keep falling |
| Read API | Your account can still be rebuilt from chain data |
| Price feed | Closing waits for a fresh price. See [dead-oracle rules](/closing-and-liquidation#if-the-price-feed-dies) |
| The chain | Nothing works until it's back |

Your free balance never depends on a maker. Whoever controls the account can spend it.

## Interrupted actions

If you close a tab in the middle of an action, the operation center picks it up when you come back. Rooq checks what happened on the chain first, so an action isn't sent twice.

Locks that have expired can be refunded from **Overview**.
