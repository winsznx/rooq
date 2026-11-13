import { ROBINHOOD_TESTNET, TESTNET_STOCK_TOKENS, TESTNET_USDG, type Address } from "@rooq/config";

export interface ContractRow {
  readonly name: string;
  readonly address: Address | null;
  readonly role: string;
}

export const EXPLORER_URL = ROBINHOOD_TESTNET.explorerUrl ?? "";

/** Robinhood Chain testnet (46630). Source of truth: contracts/deployments/privacy-46630.json. */
export const ROOQ_CONTRACTS: readonly ContractRow[] = [
  { name: "PrivatePairs", address: "0x6b3dEA9d7C3FaCbFd8Eb78c101f0C0fF45648DF5", role: "Holds all tokens. Runs the note tree, private balances, perps, funding and forced exits. It has no admin and no pause." },
  { name: "PrivateSpot", address: "0x0F792918dC1949de932AC11446fba82beBa32404", role: "Private pools and liquidity. It cannot move tokens. Pools and fees are fixed at deployment." },
  { name: "PrivateMarkets", address: "0xDCec34FAECaFC1A988b8854521DaBBb1E40bC4af", role: "Perps market settings and bonds. It cannot move tokens." },
  { name: "OracleAdapter", address: "0x696949Bd13565f3A8364543D6bC8aCfF1e928c79", role: "Accepts a price only if it is fresh, in range and from the feed approved for that token." },
];

export const THIRD_PARTY_CONTRACTS: readonly ContractRow[] = [
  { name: TESTNET_USDG.symbol, address: TESTNET_USDG.address, role: "Global Dollar testnet token from Paxos. Used for margin and as the spot quote token." },
  ...TESTNET_STOCK_TOKENS.map((token) => ({ name: token.symbol, address: token.address, role: "Stock Token on Robinhood Chain testnet." })),
];
