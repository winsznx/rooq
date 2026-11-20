import type { Address } from "viem";

/**
 * Rooq's testnet contracts and what each action reveals. Addresses come from contracts/deployments/privacy-46630.json,
 * selectors from the compiled ABIs, and the privacy wording from the docs' "who sees" tables.
 */
export const ROOQ_CONTRACTS: Readonly<Record<string, { readonly name: string; readonly address: Address }>> = {
  pool: { name: "PrivatePairs", address: "0x6b3dEA9d7C3FaCbFd8Eb78c101f0C0fF45648DF5" },
  spot: { name: "PrivateSpot", address: "0x0F792918dC1949de932AC11446fba82beBa32404" },
  markets: { name: "PrivateMarkets", address: "0xDCec34FAECaFC1A988b8854521DaBBb1E40bC4af" },
  oracle: { name: "OracleAdapter", address: "0x696949Bd13565f3A8364543D6bC8aCfF1e928c79" },
};

/** Rooq's own public service wallets. Naming them is honest: they're operators, not users. */
export const ROOQ_OPERATORS: Readonly<Record<string, string>> = {
  "0xe5dad32cdc950367cf5db2d0aae01f3079d8a017": "Rooq relayer",
  "0x0ec52416cd54be1dced168a1029004fc631e0ff5": "Rooq coordinator",
  "0x77328e4b426917b80ad1b529610884b14c736c1f": "Rooq queue",
  "0xca34db6ce6967cb15340e777ad18b8f91dc201f5": "Rooq risk worker",
  "0x8705e8dd0082261dfb0c37275b71bd95fca6f0c2": "Rooq risk worker",
  "0x109204c94872210cc9d666a284ba4069c6de2e55": "Rooq price relay",
  "0xc1207e46f4f5322033685131a0e2640f2d3324da": "Rooq deployer",
};

export interface ActionFacts {
  readonly label: string;
  /** What anyone reading the chain learns from this action. */
  readonly onChain: readonly string[];
  /** What this action keeps off the public record. */
  readonly offChain: readonly string[];
}

const PRIVATE_TRADE: ActionFacts = {
  label: "Private trade step",
  onChain: ["That a proof was accepted", "Which contract and which service sent it"],
  offChain: ["The amount", "The direction", "The trader's wallet"],
};

export const ROOQ_ACTIONS: Readonly<Record<string, ActionFacts>> = {
  "0xc46c36b3": {
    label: "Shield (move money in)",
    onChain: ["The wallet that shielded", "The token", "The amount", "The time"],
    offChain: ["What the money does next inside Rooq"],
  },
  "0x8ee8ac74": {
    label: "Private spend",
    onChain: ["That a private spend happened", "Which service submitted it"],
    offChain: ["The amount", "The token", "The sender", "The recipient"],
  },
  "0x13a40c37": {
    label: "Private lock (an order waiting to fill)",
    onChain: ["That a lock was placed", "Which service submitted it"],
    offChain: ["The size", "The side", "The limit price", "The trader's wallet"],
  },
  "0x71bea4e8": {
    label: "Private swap",
    onChain: ["That a pool changed"],
    offChain: ["The amount", "The direction", "The trader"],
  },
  "0x58ec4141": {
    label: "Add liquidity privately",
    onChain: ["That a pool changed"],
    offChain: ["The provider's share", "The amounts", "The provider's wallet"],
  },
  "0xcceeb662": {
    label: "Remove liquidity privately",
    onChain: ["That a pool changed"],
    offChain: ["The provider's share", "The amounts", "The provider's wallet"],
  },
  "0x1a9400ec": { ...PRIVATE_TRADE, label: "Private liquidity request" },
  "0x6574448d": {
    label: "Private perp opened",
    onChain: ["That a position opened in a market", "Which market"],
    offChain: ["The size", "The side", "The entry price", "The owner"],
  },
  "0xa3d8aa73": {
    label: "Private perp changed",
    onChain: ["That a position changed in a market"],
    offChain: ["The size", "The side", "The new margin", "The owner"],
  },
  "0xe1119e9d": {
    label: "Private perp closed",
    onChain: ["That a position closed in a market", "The market price used"],
    offChain: ["The size", "The side", "The profit or loss", "The owner"],
  },
  "0xaae230f4": {
    label: "Liquidation",
    onChain: ["That a position in a market was liquidated", "The price"],
    offChain: ["The amounts", "The owner"],
  },
  "0x4e47c1de": { ...PRIVATE_TRADE, label: "Private release (refund of an unfilled lock)" },
  "0xacf92518": { ...PRIVATE_TRADE, label: "Exit request" },
  "0x5925ea8a": {
    label: "Funding update",
    onChain: ["The market's funding index and time"],
    offChain: ["Any single position's funding"],
  },
  "0x6057e0eb": {
    label: "Queue processing",
    onChain: ["That queued notes were added to the tree"],
    offChain: ["What the notes hold or who owns them"],
  },
  "0x802b00cf": {
    label: "Market created",
    onChain: ["The creator's wallet", "The price feed", "The bond"],
    offChain: [],
  },
  "0xda3203cb": { ...PRIVATE_TRADE, label: "Shortfall claim redeemed" },
};

/** Unshield is a spend whose output leaves to a public address, so it's recognised by its event, not its selector. */
export const UNSHIELD_FACTS: ActionFacts = {
  label: "Unshield (move money out)",
  onChain: ["The recipient's address", "The token", "The amount", "The time"],
  offChain: ["Where inside Rooq the money came from"],
};
