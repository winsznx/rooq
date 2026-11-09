import type { Address, Hex } from "viem";

/**
 * Mirrors `Types.Quote` and `QuoteVerifier.QUOTE_TYPEHASH` field for field. A type alias with mutable
 * fields so it stays assignable to viem's ABI-derived struct argument types.
 */
export type MakerQuote = {
  marketId: Hex;
  maker: Address;
  taker: Address;
  /** Taker-perspective signed base size, 18 decimals. Positive: taker buys. */
  size: bigint;
  /** 18-decimal USD per base unit. */
  price: bigint;
  minFill: bigint;
  nonce: bigint;
  /** Unix seconds, checked against block.timestamp. */
  deadline: bigint;
  policyVersion: number;
};

export const QUOTE_TYPES = {
  Quote: [
    { name: "marketId", type: "bytes32" },
    { name: "maker", type: "address" },
    { name: "taker", type: "address" },
    { name: "size", type: "int256" },
    { name: "price", type: "uint256" },
    { name: "minFill", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "policyVersion", type: "uint32" },
  ],
} as const;

/** The domain binds chain id and the exact ClearingHouse, so a quote cannot be replayed elsewhere. */
export function quoteDomain(chainId: number, clearingHouse: Address) {
  return { name: "Rooq", version: "1", chainId, verifyingContract: clearingHouse } as const;
}

export interface SignedQuote {
  readonly quote: MakerQuote;
  readonly signature: Hex;
  readonly signer: Address;
}
