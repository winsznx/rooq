import { getAddress } from "viem";
import { createSiweMessage } from "viem/siwe";
import { CHAIN_CONFIG } from "@/lib/env";
import type { AccountDerivation } from "./deployment-pin";
import { PRIVATE_DEPLOYMENT_PIN } from "./config";

/** A pinned deployment keeps the derivation its accounts were opened with; anything unpinned (local) uses the latest. */
export const ACCOUNT_DERIVATION: AccountDerivation = PRIVATE_DEPLOYMENT_PIN?.accountDerivation ?? 2;

/** Fixed, so the same wallet always derives the same account. Changing a word changes every account, so don't. */
const ACCOUNT_MESSAGE_V1 = `Rooq private account

Signing this opens your private account on Rooq. It is free and sends no transaction.

Whoever has this signature controls your private account. Only sign this on Rooq.

Network: ${CHAIN_CONFIG.name} (chain ${CHAIN_CONFIG.chainId})
Version: 1`;

/**
 * Every field is a frozen literal: the domain, URI, nonce and time never follow the page's origin or the clock, so the
 * same wallet always signs the same bytes. Wallets that check SIWE domains warn when another site asks for it.
 */
const ACCOUNT_SIWE_V2 = {
  domain: "rooq.trade",
  uri: "https://rooq.trade",
  version: "1",
  nonce: "rooqprivateaccountv2",
  issuedAt: new Date("2026-11-17T00:00:00.000Z"),
  statement: "Open your Rooq private account. This signature is the key to your private balance: anyone who gets it can spend it. Only sign this on rooq.trade.",
} as const;

export function accountMessage(address: string, derivation: AccountDerivation = ACCOUNT_DERIVATION): string {
  if (derivation === 1) return ACCOUNT_MESSAGE_V1;
  return createSiweMessage({ ...ACCOUNT_SIWE_V2, address: getAddress(address), chainId: CHAIN_CONFIG.chainId });
}
