import { CHAINS, TESTNET_STOCK_TOKENS, TESTNET_USDG, TESTNET_WETH } from "@rooq/config";
import { createPublicClient, decodeEventLog, erc20Abi, formatUnits, http, parseAbi, type Address, type Hex, type Log, type PublicClient } from "viem";
import { ROOQ_ACTIONS, ROOQ_CONTRACTS, ROOQ_OPERATORS, UNSHIELD_FACTS, type ActionFacts } from "./rooq-actions";

const ROOQ_EVENTS = parseAbi([
  "event Shielded(uint256 indexed leafIndex, address indexed asset, uint256 amount, bytes32 inner, address indexed from)",
  "event Unshielded(address indexed asset, address indexed recipient, uint256 amount, address relayer, uint256 fee)",
  "event NotesCreated(uint256 indexed firstLeafIndex, bytes32[3] commitments, bytes32[7][3] ciphertexts)",
  "event NullifiersSpent(bytes32[2] nullifiers)",
  "event RecordCreated(uint256 indexed leafIndex, uint8 indexed kind, bytes32 commitment, bytes32[] ciphertext)",
  "event RecordsConsumed(bytes32[] nullifiers)",
  "event PairOpened(uint256 indexed market, bytes32 commitment)",
  "event PairClosed(uint256 indexed market, bytes32 nullifier, uint256 mode, uint256 mark)",
  "event PairLiquidated(uint256 indexed market, bytes32 nullifier, uint256 mark)",
  "event PoolUpdated(uint256 indexed pool, bytes32 head, bytes32[] ciphertext)",
  "event FundingAdvanced(uint256 indexed market, uint256 index, uint256 asOf, uint256 dt, uint256 mark, bytes32 head, uint256 consumed, bytes32[] ciphertext)",
]);

const KNOWN_TOKENS = new Map<string, { symbol: string; decimals: number }>(
  [...TESTNET_STOCK_TOKENS, TESTNET_USDG, TESTNET_WETH].map((t) => [t.address.toLowerCase(), { symbol: t.symbol, decimals: t.decimals }]),
);

const ROOQ_ADDRESSES = new Map(Object.values(ROOQ_CONTRACTS).map((c) => [c.address.toLowerCase(), c.name]));

export const INSPECT_CHAIN = CHAINS.testnet;

export interface Party {
  readonly address: Address;
  readonly label: string | null;
}

export interface PublicFact {
  readonly label: string;
  readonly value: string;
  /** Set when the value is a wallet or contract address, so the page can label and link it. */
  readonly party?: Party;
}

export interface TokenTransfer {
  readonly token: string;
  readonly from: Party;
  readonly to: Party;
  readonly amount: string;
}

export interface InspectResult {
  readonly hash: Hex;
  readonly status: "success" | "reverted";
  readonly block: bigint;
  readonly timestamp: number;
  readonly from: Party;
  readonly to: Party | null;
  readonly gasUsed: bigint;
  readonly inputBytes: number;
  /** Present only when the transaction called a Rooq contract. */
  readonly rooq: { readonly contract: string; readonly facts: ActionFacts; readonly values: readonly PublicFact[]; readonly opaque: readonly PublicFact[] } | null;
  readonly transfers: readonly TokenTransfer[];
}

export class InspectError extends Error {
  override readonly name = "InspectError";
  constructor(readonly reason: "BAD_HASH" | "NOT_FOUND" | "RPC_FAILED") {
    super(reason);
  }
}

export function isTxHash(value: string): value is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(value.trim());
}

export function partyOf(address: Address): Party {
  const key = address.toLowerCase();
  return { address, label: ROOQ_OPERATORS[key] ?? ROOQ_ADDRESSES.get(key) ?? null };
}

function tokenOf(address: Address): { symbol: string; decimals: number } | null {
  return KNOWN_TOKENS.get(address.toLowerCase()) ?? null;
}

async function readToken(client: PublicClient, address: Address): Promise<{ symbol: string; decimals: number }> {
  const known = tokenOf(address);
  if (known) return known;
  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    ]);
    return { symbol, decimals };
  } catch {
    return { symbol: `${address.slice(0, 6)}…${address.slice(-4)}`, decimals: 18 };
  }
}

function amountText(raw: bigint, token: { symbol: string; decimals: number }): string {
  const n = Number(formatUnits(raw, token.decimals));
  return `${n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 4 })} ${token.symbol}`;
}

function wadPrice(raw: bigint): string {
  return `$${Number(formatUnits(raw, 18)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function transfersIn(client: PublicClient, logs: readonly Log[]): Promise<TokenTransfer[]> {
  const out: TokenTransfer[] = [];
  for (const log of logs) {
    try {
      const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (ev.eventName !== "Transfer") continue;
      const token = await readToken(client, log.address);
      out.push({ token: token.symbol, from: partyOf(ev.args.from), to: partyOf(ev.args.to), amount: amountText(ev.args.value, token) });
    } catch {
      continue;
    }
  }
  return out;
}

async function rooqDetails(client: PublicClient, input: Hex, logs: readonly Log[]): Promise<{ facts: ActionFacts; values: PublicFact[]; opaque: PublicFact[] }> {
  let facts: ActionFacts = ROOQ_ACTIONS[input.slice(0, 10).toLowerCase()] ?? { label: "Rooq contract call", onChain: ["That the contract was called"], offChain: [] };
  const values: PublicFact[] = [];
  let commitments = 0;
  let nullifiers = 0;
  let records = 0;
  for (const log of logs) {
    let ev;
    try {
      ev = decodeEventLog({ abi: ROOQ_EVENTS, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    switch (ev.eventName) {
      case "Shielded": {
        const token = await readToken(client, ev.args.asset);
        values.push({ label: "Shielded by", value: ev.args.from, party: partyOf(ev.args.from) }, { label: "Amount", value: amountText(ev.args.amount, token) });
        break;
      }
      case "Unshielded": {
        const token = await readToken(client, ev.args.asset);
        facts = UNSHIELD_FACTS;
        values.push({ label: "Sent to", value: ev.args.recipient, party: partyOf(ev.args.recipient) }, { label: "Amount", value: amountText(ev.args.amount, token) });
        break;
      }
      case "PairOpened":
        values.push({ label: "Market", value: `#${ev.args.market}` });
        commitments += 1;
        break;
      case "PairClosed":
      case "PairLiquidated":
        values.push({ label: "Market", value: `#${ev.args.market}` }, { label: "Market price used", value: wadPrice(ev.args.mark) });
        nullifiers += 1;
        break;
      case "PoolUpdated":
        values.push({ label: "Pool", value: `#${ev.args.pool}` });
        records += 1;
        break;
      case "FundingAdvanced":
        values.push({ label: "Market", value: `#${ev.args.market}` });
        break;
      case "NotesCreated":
        commitments += ev.args.commitments.length;
        break;
      case "NullifiersSpent":
        nullifiers += ev.args.nullifiers.length;
        break;
      case "RecordCreated":
        records += 1;
        break;
      case "RecordsConsumed":
        nullifiers += ev.args.nullifiers.length;
        break;
    }
  }
  const opaque: PublicFact[] = [];
  if (commitments) opaque.push({ label: "New private notes", value: `${commitments}, as unreadable commitments` });
  if (records) opaque.push({ label: "Encrypted records", value: `${records}, readable only by their owners` });
  if (nullifiers) opaque.push({ label: "Spent notes", value: `${nullifiers}, as nullifiers that don't say which note` });
  return { facts, values, opaque };
}

let cachedClient: PublicClient | null = null;
function client(): PublicClient {
  cachedClient ??= createPublicClient({ transport: http(INSPECT_CHAIN.rpcUrls[0], { timeout: 10_000, retryCount: 1 }) });
  return cachedClient;
}

/** Reads one testnet transaction and splits what it made public from what Rooq kept private. Public data only. */
export async function inspectTransaction(rawHash: string): Promise<InspectResult> {
  const hash = rawHash.trim();
  if (!isTxHash(hash)) throw new InspectError("BAD_HASH");
  const c = client();
  let tx, receipt;
  try {
    [tx, receipt] = await Promise.all([c.getTransaction({ hash }), c.getTransactionReceipt({ hash })]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    throw new InspectError(/not found|could not be found/i.test(message) ? "NOT_FOUND" : "RPC_FAILED");
  }
  const block = await c.getBlock({ blockNumber: receipt.blockNumber });
  const toKey = tx.to?.toLowerCase() ?? "";
  const contract = ROOQ_ADDRESSES.get(toKey) ?? null;
  return {
    hash,
    status: receipt.status,
    block: receipt.blockNumber,
    timestamp: Number(block.timestamp),
    from: partyOf(tx.from),
    to: tx.to ? partyOf(tx.to) : null,
    gasUsed: receipt.gasUsed,
    inputBytes: (tx.input.length - 2) / 2,
    rooq: contract ? { contract, ...(await rooqDetails(c, tx.input, receipt.logs)) } : null,
    transfers: await transfersIn(c, receipt.logs),
  };
}
