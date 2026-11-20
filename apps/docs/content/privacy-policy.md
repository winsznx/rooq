Last updated November 15, 2026.

Rooq is built to know as little about you as possible. This policy covers the Rooq app, these docs and the services behind them.

## The short version

Rooq has no accounts and no sign-up. Your private account stays on your device. Rooq doesn't collect your name, email or location. It counts page views as hourly totals, with no cookies and nothing that tells one visitor from another.

Using a public chain has its own effects, and those are covered below.

## What stays in your browser

- Your private keys, derived in your browser and held in memory while your account is open. They never reach a server.
- If you choose to remember this device, your account encrypted under a passkey or a key that can't leave the browser.
- Your theme, slippage limit, last market and leverage acknowledgement.
- Your in-progress operations, encrypted until you unlock.
- The date of your last visit, so a page view can count as your first one that day. See [Page views](#page-views).

Rooq's servers don't receive these. Your account signature and keys never leave your device. Clearing your browser data removes them from this browser.

## What the services handle

Rooq's services work with public chain data and the requests you send them.

- **Read API.** It serves public data and keeps no per-client state. Lookups tied to your secrets go in request bodies so they don't end up in URLs or access logs.
- **Relayer.** It receives proofs and encrypted data that are about to become public.
- **Coordinator and risk workers.** They can read what's listed on [How privacy works](/how-privacy-works). This is part of how Rooq operates. They can keep what they have read.
- **Logs.** Service logs leave out IP addresses, keys, proofs, witnesses and encrypted data.
- **Admin totals.** Rooq's operator sees totals built from public chain data, such as how many shields happened in a day, and the page view totals below. These totals don't show individual trades, positions or the wallets behind them.

Rate limits hold your IP address in memory for one minute. They aren't written to disk.

## Page views

Rooq counts page views on the app and these docs to see which pages people use. Each view sends five things:

- Whether it was the app or these docs.
- The page's pattern, such as `/app/perps/[market]`, in place of the real address. Search terms, query strings and anything after the page's address are left out.
- If another site sent you, its domain, on the first page you open.
- Whether your screen is phone, tablet or desktop sized.
- Whether this is the first view in this browser today, by the UTC date.

The service adds each view to a total for its hour and keeps only the totals. It doesn't use cookies or any identifier, and it doesn't store your IP address, a hash of it or your browser's user agent. Like every request, a page view goes through the rate limit, which holds your IP address in memory for one minute.

To tell whether a view is your first today, your browser keeps the date of your last visit under the key `rooq-pv-day`. It holds only a date, which is the same for everyone who visits that day, so it can't identify you. If your browser blocks storage, the view is still counted but not as a visit. If your browser sends Global Privacy Control or Do Not Track, Rooq sends nothing.

Rooq sets cookies only for signing in to its admin pages. Starting a sign-in there sets a short-lived cookie that expires within minutes, and a successful sign-in by Rooq's operator sets a session cookie. Reading the app or these docs never sets a cookie.

## What is public on the chain

A public chain is permanent. Shields and unshields show the address, token, amount and time. Rooq publishes market data, as described on [How privacy works](/how-privacy-works). Rooq can't delete anything from the chain.

## These docs

These docs count page views the way [Page views](#page-views) describes, with no cookies. Search terms go to the docs server to find results and aren't stored by it. The companies that host Rooq keep standard server logs, including IP addresses and page requests.

## Third parties

Your wallet, RPC provider and network provider can see your activity under their own policies. Rooq has no control over them. The faucets you use are run by others.

## Your choices

You can use a VPN or Tor. You can clear your browser data whenever you want. Your wallet and any passkey are yours to manage.

Rooq doesn't hold personal data about you, so there's usually nothing to give you, change or delete. If you have a question or a request, write to [{{support_email}}](mailto:{{support_email}}).

## Children

Rooq isn't for anyone under 18.

## Changes

We'll update the date at the top when this policy changes.
