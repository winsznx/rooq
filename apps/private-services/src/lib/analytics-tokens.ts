import { erc20Abi, getAddress, type Address, type Chain, type PublicClient, type Transport } from "viem";
import { errorMessage, type Logger } from "./log";

export interface TokenInfo {
  readonly symbol: string;
  readonly decimals: number;
}

export type TokenReader = (address: Address) => Promise<TokenInfo>;

export function erc20Reader(client: PublicClient<Transport, Chain>): TokenReader {
  return async (address) => {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    ]);
    return { symbol, decimals };
  };
}

/** Symbols and decimals for every asset the admin page names, read from chain once each and kept for the process. */
export class TokenBook {
  private readonly known = new Map<string, TokenInfo>();

  constructor(
    private readonly read: TokenReader,
    private readonly log: Logger,
  ) {}

  async load(addresses: readonly string[]): Promise<void> {
    const missing = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => !this.known.has(a));
    await Promise.all(missing.map(async (address) => {
      try {
        this.known.set(address, await this.read(getAddress(address)));
      } catch (error) {
        this.log.warn("token_read_failed", { asset: address, message: errorMessage(error) });
      }
    }));
  }

  /** Null until the token has been read; callers show the address instead of guessing decimals. */
  info(address: string): TokenInfo | null {
    return this.known.get(address.toLowerCase()) ?? null;
  }
}
