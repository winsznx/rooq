Your funds are in the contract, not your browser. What you need to reach them depends on how your account was created.

## Restoring your account

- **Signed with your wallet.** Connect the same wallet and sign the same message on any device. Rooq derives the same account.
- **Passkey.** Use a synced Rooq passkey on your new device and it brings back the same account.
- **Generated 24-word phrase.** Choose **Restore** and enter your words.

Rooq then rebuilds your notes, positions and receipts from chain data. Nothing else is needed. If you have a long history, this can take a while.

This works for anything that happened while you were away, including funding, liquidations and forced closes. Encrypted results are written to the chain for you to find.

## What each secret does

| Secret | What it does | If you lose it |
| --- | --- | --- |
| Your wallet | Derives your private account with one signature | Your account is gone with it, unless you also use a passkey or phrase |
| Passkey | Opens a remembered device, or derives an account on a wallet that can't sign the same way twice | Sign with your wallet again, or use your phrase |
| Generated 24-word phrase | Spends your account and restores it anywhere | Your funds are gone. Nobody can recover it |

Whoever controls your wallet controls your private account. Rooq can't freeze, reverse or recover anything.

## Lost device

Your funds stay in the contract. Restore on another device with the method above. An open position stays exposed to the market while you're away, and it can be liquidated.

If you think someone else has your wallet or phrase, restore on a clean device right away and move your funds to a new account with a private transfer.

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
