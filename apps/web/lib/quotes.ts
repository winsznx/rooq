"use client";

import { getAddress, hashTypedData, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { QUOTE_TYPES, quoteDomain, type MakerQuote } from "@rooq/sdk";
import { API_URL, DEPLOYMENT, MAKER_URL } from "./env";

export interface SignedQuote {
  readonly quote: MakerQuote;
  readonly signature: Hex;
  readonly signer: Address;
  readonly quoteHash: Hex;
  readonly mark: bigint;
  /** Chain time (seconds) when the maker signed, so expiry is counted in chain time. */
  readonly chainTime: number;
  readonly receivedAt: number;
}

export class QuoteRefused extends Error {
  readonly reasonCode: string;
  readonly details: unknown;
  constructor(reasonCode: string, message: string, details: unknown) {
    super(message);
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

interface WireQuote {
  quote: Record<keyof MakerQuote, string | number>;
  signature: Hex;
  signer: Address;
  quoteHash: Hex;
  mark: string;
  chainTime: string;
}

async function post(url: string, body: unknown, signal: AbortSignal): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
}

/**
 * Requests a firm, taker-bound quote. Tries the API proxy first and the maker service directly if the
 * API is unreachable. The response is indicative until the ClearingHouse verifies it onchain.
 */
export async function requestPerpQuote(args: { marketId: Hex; taker: Address; size: bigint }): Promise<SignedQuote> {
  const body = { marketId: args.marketId, taker: args.taker, size: args.size.toString() };
  let res: Response;
  try {
    res = await post(`${API_URL}/quotes/perps`, body, AbortSignal.timeout(5_000));
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
    res = await post(`${MAKER_URL}/quote`, body, AbortSignal.timeout(5_000));
  }
  const json = (await res.json()) as WireQuote & { reasonCode?: string; message?: string; details?: unknown };
  if (!res.ok) throw new QuoteRefused(json.reasonCode ?? "INTERNAL", json.message ?? "No quote", json.details);
  const q = json.quote;
  const quote: MakerQuote = {
    marketId: q.marketId as Hex,
    maker: q.maker as Address,
    taker: q.taker as Address,
    size: BigInt(q.size),
    price: BigInt(q.price),
    minFill: BigInt(q.minFill),
    nonce: BigInt(q.nonce),
    deadline: BigInt(q.deadline),
    policyVersion: Number(q.policyVersion),
  };
  const signed = await checkQuote(quote, json, args);
  return {
    quote,
    signature: json.signature,
    signer: signed.signer,
    quoteHash: signed.quoteHash,
    mark: BigInt(json.mark),
    chainTime: Number(json.chainTime),
    receivedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * The quote arrives through an offchain service, so it is checked before the user sees it: it must be
 * for this taker, market and size, and its signature must recover to the signer the service named over
 * the hash the service named. The ClearingHouse still decides whether that signer may sign for the maker.
 */
async function checkQuote(
  quote: MakerQuote,
  wire: WireQuote,
  asked: { marketId: Hex; taker: Address; size: bigint },
): Promise<{ signer: Address; quoteHash: Hex }> {
  if (!DEPLOYMENT) throw new QuoteRefused("INTERNAL", "No deployment is configured for this network.", null);
  if (quote.marketId.toLowerCase() !== asked.marketId.toLowerCase() || getAddress(quote.taker) !== getAddress(asked.taker) || quote.size !== asked.size) {
    throw new QuoteRefused("INTERNAL", "The quote returned does not match the trade you asked for. Nothing was signed.", null);
  }
  const typed = { domain: quoteDomain(DEPLOYMENT.chainId, DEPLOYMENT.clearingHouse), types: QUOTE_TYPES, primaryType: "Quote", message: quote } as const;
  const quoteHash = hashTypedData(typed);
  const recovered = await recoverTypedDataAddress({ ...typed, signature: wire.signature });
  if (quoteHash !== wire.quoteHash || recovered !== getAddress(wire.signer)) {
    throw new QuoteRefused("INTERNAL", "The quote signature does not check out. Nothing was signed.", null);
  }
  return { signer: recovered, quoteHash };
}
