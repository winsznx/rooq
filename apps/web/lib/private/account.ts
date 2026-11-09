import { CHAIN_CONFIG } from "@/lib/env";

/** Fixed, so the same wallet always derives the same account. Changing a word changes every account, so don't. */
export const ACCOUNT_MESSAGE = `Rooq private account

Signing this opens your private account on Rooq. It is free and sends no transaction.

Whoever has this signature controls your private account. Only sign this on Rooq.

Network: ${CHAIN_CONFIG.name} (chain ${CHAIN_CONFIG.chainId})
Version: 1`;
