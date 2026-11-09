Last updated November 8, 2026.

Rooq is built to know as little about you as possible. This policy covers the Rooq app, these docs and the services behind them.

## The short version

Rooq has no accounts, no sign-up and no analytics. Your private account stays on your device. Rooq doesn't collect your name, email or location.

Using a public chain has its own effects, and those are covered below.

## What stays in your browser

- Your private keys, derived in your browser and held in memory while your account is open. They never reach a server.
- If you choose to remember this device, your account encrypted under a passkey or a key that can't leave the browser.
- Your theme, slippage limit, last market and leverage acknowledgement.
- Your in-progress operations, encrypted until you unlock.

Rooq's servers don't receive these. Your account signature and keys never leave your device. Clearing your browser data removes them from this browser.

## What the services handle

Rooq's services work with public chain data and the requests you send them.

- **Read API.** It serves public data and keeps no per-client state. Lookups tied to your secrets go in request bodies so they don't end up in URLs or access logs.
- **Relayer.** It receives proofs and encrypted data that are about to become public.
- **Coordinator and risk workers.** They can read what's listed on [How privacy works](/how-privacy-works). This is part of how Rooq operates. They can keep what they have read.
- **Logs.** Service logs leave out IP addresses, keys, proofs, witnesses and encrypted data.

Rate limits hold your IP address in memory for one minute. They aren't written to disk.

## What is public on the chain

A public chain is permanent. Shields and unshields show the address, token, amount and time. Rooq publishes market data, as described on [How privacy works](/how-privacy-works). Rooq can't delete anything from the chain.

## These docs

These docs have no analytics or tracking cookies. Search terms go to the docs server to find results and aren't stored by it. The companies that host Rooq keep standard server logs, including IP addresses and page requests.

## Third parties

Your wallet, RPC provider and network provider can see your activity under their own policies. Rooq has no control over them. The faucets you use are run by others.

## Your choices

You can use a VPN or Tor. You can clear your browser data whenever you want. Your wallet and any passkey or phrase are yours to manage.

Rooq doesn't hold personal data about you, so there's usually nothing to give you, change or delete. If you have a question or a request, write to [{{support_email}}](mailto:{{support_email}}).

## Children

Rooq isn't for anyone under 18.

## Changes

We'll update the date at the top when this policy changes.
