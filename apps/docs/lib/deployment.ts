import { ROBINHOOD_TESTNET, TESTNET_STOCK_TOKENS, TESTNET_USDG, type Address } from "@rooq/config";

export interface ContractRow {
  readonly name: string;
  readonly address: Address | null;
  readonly role: string;
}

export const EXPLORER_URL = ROBINHOOD_TESTNET.explorerUrl ?? "";

/** Set each address from the private broadcast. `null` renders as "Published at launch". */
export const ROOQ_CONTRACTS: readonly ContractRow[] = [
  { name: "PrivatePairs", address: null, role: "Holds all tokens. Runs the note tree, private balances, perps, funding and forced exits. It has no admin and no pause." },
  { name: "PrivateSpot", address: null, role: "Private pools and liquidity. It cannot move tokens. Pools and fees are fixed at deployment." },
  { name: "OracleAdapter", address: null, role: "Accepts a price only if it is fresh, in range and from the feed approved for that token." },
];

export const THIRD_PARTY_CONTRACTS: readonly ContractRow[] = [
  { name: TESTNET_USDG.symbol, address: TESTNET_USDG.address, role: "Global Dollar testnet token from Paxos. Used for margin and as the spot quote token." },
  ...TESTNET_STOCK_TOKENS.map((token) => ({ name: token.symbol, address: token.address, role: "Stock Token on Robinhood Chain testnet." })),
];
