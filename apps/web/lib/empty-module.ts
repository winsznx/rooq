/**
 * Stands in for @base-org/account. RainbowKit's wallet barrel reaches it through a connector this app doesn't use (injected
 * wallets only), and it would otherwise pull Coinbase's server SDK, with unresolved optional imports, into the key-handling page.
 */
export {};
