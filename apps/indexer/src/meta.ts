import { BaseError, HttpRequestError, TimeoutError, WebSocketRequestError, type Address, type Chain, type PublicClient, type Transport } from "viem";
import { mockERC20Abi, mockPriceFeedAbi } from "@rooq/sdk";
import type { Queryable } from "./db";
import { warn } from "./log";

export interface ContractMeta {
  readonly address: Address;
  readonly kind: "token" | "feed";
  readonly decimals: number;
  readonly symbol: string | null;
  readonly name: string | null;
}

interface MetaRow {
  readonly address: Address;
  readonly kind: "token" | "feed";
  readonly decimals: number;
  readonly symbol: string | null;
  readonly name: string | null;
}

export async function loadMeta(q: Queryable, chainId: number): Promise<Map<Address, ContractMeta>> {
  const rows = await q<MetaRow[]>`SELECT address, kind, decimals, symbol, name FROM contract_meta WHERE chain_id = ${chainId}`;
  return new Map(rows.map((r) => [r.address, r]));
}

async function optionalString(read: () => Promise<string>, address: Address, field: string): Promise<string | null> {
  try {
    return await read();
  } catch (error) {
    warn("token_metadata_unreadable", { address, field, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** The RPC failed, as opposed to the contract answering badly. Retry those instead of skipping the token. */
function isTransportFailure(error: unknown): boolean {
  const transport = (e: unknown) => e instanceof HttpRequestError || e instanceof TimeoutError || e instanceof WebSocketRequestError;
  return error instanceof BaseError ? Boolean(error.walk(transport)) : !(error instanceof Error);
}

export async function readTokenDecimals(client: PublicClient<Transport, Chain>, address: Address): Promise<number | null> {
  try {
    const decimals = await client.readContract({ address, abi: mockERC20Abi, functionName: "decimals" });
    if (decimals <= 18) return decimals;
    warn("token_decimals_unsupported", { address, decimals });
    return null;
  } catch (error) {
    if (isTransportFailure(error)) throw error;
    warn("token_decimals_unreadable", { address, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Reads decimals (and token symbol/name) for addresses not yet in contract_meta. These values are
 * immutable for the token and feed contracts Rooq accepts, so they are fetched once and treated as
 * static reducer context. Pools are permissionless, so a token whose decimals() reverts or exceeds 18
 * is left out of contract_meta: reducers already treat unknown decimals as "no normalised price", and a
 * hostile token must never stop the indexer. Feeds are admin-registered, so a broken feed is a hard error.
 */
export async function ensureMeta(
  q: Queryable,
  client: PublicClient<Transport, Chain>,
  chainId: number,
  known: Map<Address, ContractMeta>,
  wanted: { readonly tokens: readonly Address[]; readonly feeds: readonly Address[] },
): Promise<Map<Address, ContractMeta>> {
  const missingTokens = [...new Set(wanted.tokens)].filter((a) => !known.has(a));
  const missingFeeds = [...new Set(wanted.feeds)].filter((a) => !known.has(a));
  if (missingTokens.length === 0 && missingFeeds.length === 0) return known;
  const block = await client.getBlockNumber({ cacheTime: 0 });
  const tokens = (
    await Promise.all(
      missingTokens.map(async (address): Promise<ContractMeta | null> => {
        const decimals = await readTokenDecimals(client, address);
        if (decimals === null) return null;
        const [symbol, name] = await Promise.all([
          optionalString(() => client.readContract({ address, abi: mockERC20Abi, functionName: "symbol" }), address, "symbol"),
          optionalString(() => client.readContract({ address, abi: mockERC20Abi, functionName: "name" }), address, "name"),
        ]);
        return { address, kind: "token", decimals, symbol, name };
      }),
    )
  ).filter((m): m is ContractMeta => m !== null);
  const feeds = await Promise.all(
    missingFeeds.map(async (address): Promise<ContractMeta> => {
      const [decimals, description] = await Promise.all([
        client.readContract({ address, abi: mockPriceFeedAbi, functionName: "decimals" }),
        optionalString(() => client.readContract({ address, abi: mockPriceFeedAbi, functionName: "description" }), address, "description"),
      ]);
      return { address, kind: "feed", decimals, symbol: null, name: description };
    }),
  );
  const fresh = [...tokens, ...feeds];
  for (const m of fresh) {
    await q`INSERT INTO contract_meta (chain_id, address, kind, decimals, symbol, name, read_at_block)
      VALUES (${chainId}, ${m.address}, ${m.kind}, ${m.decimals}, ${m.symbol}, ${m.name}, ${block.toString()})
      ON CONFLICT (chain_id, address) DO NOTHING`;
  }
  const next = new Map(known);
  for (const m of fresh) next.set(m.address, m);
  return next;
}
