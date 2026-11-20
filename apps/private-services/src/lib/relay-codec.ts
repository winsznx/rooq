import { FIELD, LOCK_CT_LEN, LP_CT_LEN, NOTE_CT_LEN, PAIR_CT_LEN, PAIR_RECIPIENTS, POOL_CT_LEN } from "@rooq/private-sdk";
import { getAddress, isAddress, type Hex } from "viem";
import { ServiceError } from "./errors";

export const RELAY_ACTIONS = ["lock", "lockPair", "spend", "updatePair", "closePair", "requestExit", "release", "redeemClaim", "swap", "addLiquidity", "setLiquidityRequest", "removeLiquidity"] as const;
export type RelayAction = (typeof RELAY_ACTIONS)[number];

export const isRelayAction = (x: string): x is RelayAction => (RELAY_ACTIONS as readonly string[]).includes(x);

/** A real UltraHonk EVM proof is under 16 KB. Bounds calldata cost before any RPC work. */
export const MAX_PROOF_BYTES = 32 * 1024;
export const MAX_BODY_BYTES = 256 * 1024;

/** Sent by operator services (the maker) so the relayer waives their own traffic instead of charging the free allowance. */
export const SERVICE_TOKEN_HEADER = "x-rooq-service-token";

/** The service token travels in a header, so it may only go to the relayer over https or without leaving the host. */
export function serviceTokenTransportAllowed(relayerUrl: string): boolean {
  const url = new URL(relayerUrl);
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

type Shape = "field" | "uint" | "address" | Shape[] | { readonly [k: string]: Shape };

const array = (n: number, s: Shape): Shape[] => Array.from({ length: n }, () => s);
const noteCt = array(NOTE_CT_LEN, "field");
const twoNotes = array(2, "field");
const pairCts = array(PAIR_RECIPIENTS, array(PAIR_CT_LEN, "field"));
const three: Shape = array(3, "field");
const threeNoteCts = array(3, noteCt);
const poolCts = array(3, array(POOL_CT_LEN, "field"));
const lpCts = array(4, array(LP_CT_LEN, "field"));
const feeOut: Shape = { commitment: "field", ct: noteCt };
const lockShape: Shape = {
  root: "field", nullifiers: twoNotes, changeCommitment: "field", lockCommitment: "field", changeCt: noteCt, ownerCt: array(LOCK_CT_LEN, "field"), coordinatorCt: array(LOCK_CT_LEN, "field"),
  riskCt: array(2, array(LOCK_CT_LEN, "field")), asOf: "uint", relayFee: feeOut,
};

const SHAPES: Record<Exclude<RelayAction, "requestExit" | "lockPair">, Shape> = {
  lock: lockShape,
  spend: { root: "field", nullifiers: twoNotes, commitments: three, ciphertexts: threeNoteCts, publicAsset: "address", withdrawAmount: "uint", withdrawRecipient: "address", relayer: "address", relayerFee: "uint" },
  updatePair: {
    root: "field", nullifiers: twoNotes, pairCommitment: "field", outCommitment: "field", feeCommitment: "field", pairCt: pairCts, outCt: noteCt, feeCt: noteCt, market: "uint", deltaCommitment: "field",
    carriedNullifier: "field", asOf: "uint", relayFee: feeOut,
  },
  closePair: { root: "field", nullifier: "field", commitments: three, ciphertexts: threeNoteCts, market: "uint", deltaCommitment: "field", mode: "uint", relayFee: feeOut },
  release: { root: "field", nullifier: "field", commitment: "field", ciphertext: noteCt, asOf: "uint", relayFee: feeOut },
  redeemClaim: { root: "field", nullifier: "field", commitment: "field", ciphertext: noteCt, deltaCommitment: "field", relayFee: feeOut },
  swap: { root: "field", nullifier: "field", outCommitment: "field", outCt: noteCt, asOf: "uint", pool: array(2, "uint"), newHead: twoNotes, poolCt: array(2, poolCts) },
  addLiquidity: { root: "field", nullifiers: twoNotes, newHead: "field", lpCommitment: "field", lpCt: lpCts, refundCommitments: twoNotes, refundCt: array(2, noteCt), poolCt: poolCts, asOf: "uint", pool: "uint" },
  setLiquidityRequest: { root: "field", nullifier: "field", nextCommitment: "field", ct: lpCts, asOf: "uint", mode: "uint" },
  removeLiquidity: { root: "field", nullifier: "field", newHead: "field", outCommitments: twoNotes, outCt: array(2, noteCt), poolCt: poolCts, asOf: "uint", pool: "uint" },
};

const UINT256_MAX = 2n ** 256n - 1n;

function reject(path: string, what: string): never {
  throw new ServiceError(400, "INVALID_REQUEST", `${path} ${what}.`, false, { field: path });
}

function checkField(value: unknown, path: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) reject(path, "must be a 32-byte 0x hex string");
  if (BigInt(value) >= FIELD) reject(path, "is not a canonical field element");
  return value.toLowerCase() as Hex;
}

function checkUint(value: unknown, path: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value !== "string" || !/^(\d{1,78}|0x[0-9a-fA-F]{1,64})$/.test(value)) reject(path, "must be a non-negative integer (decimal or 0x hex string)");
  const n = BigInt(value);
  if (n > UINT256_MAX) reject(path, "is out of range");
  return n;
}

function validate(shape: Shape, value: unknown, path: string): unknown {
  if (typeof shape === "string") {
    if (shape === "field") return checkField(value, path);
    if (shape === "uint") return checkUint(value, path);
    if (typeof value !== "string" || !isAddress(value, { strict: false })) reject(path, "must be a 20-byte hex address");
    return getAddress(value);
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value) || value.length !== shape.length) reject(path, `must be an array of ${shape.length}`);
    return shape.map((s, i) => validate(s, value[i], `${path}[${i}]`));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject(path, "must be an object");
  const rec = value as Record<string, unknown>;
  for (const key of Object.keys(rec)) if (!(key in shape)) reject(`${path}.${key}`, "is not a known field");
  return Object.fromEntries(Object.entries(shape).map(([k, s]) => [k, validate(s, rec[k], `${path}.${k}`)]));
}

function checkProof(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(value)) reject("proof", "must be 0x hex bytes");
  if ((value.length - 2) / 2 > MAX_PROOF_BYTES) reject("proof", "is too large");
  return value.toLowerCase() as Hex;
}

export interface RelayCall {
  readonly action: RelayAction;
  readonly functionName: string;
  readonly args: readonly unknown[];
  readonly nullifiers: readonly Hex[];
}

/** A FREE note a relayed action creates that may pay the relayer: the relay fee output, or a spend's third output (D-05). */
export interface FeeOutput {
  readonly commitment: Hex;
  readonly ct: readonly Hex[];
}

const nullifiersOf = (action: RelayAction, inputs: Record<string, unknown>): Hex[] => {
  if (action === "requestExit") return [];
  return "nullifiers" in inputs ? [...(inputs.nullifiers as Hex[])] : [inputs.nullifier as Hex];
};

const FEE_FIELD_ACTIONS: ReadonlySet<RelayAction> = new Set<RelayAction>(["lock", "updatePair", "closePair", "release", "redeemClaim"]);

/**
 * The outputs of a parsed call that can pay this relayer (spec-fees.md). Empty for the actions with no fee output: exit
 * requests, LP requests and the operator-proved spot calls, which draw on the free allowance.
 */
export function feeOutputOf(call: RelayCall): FeeOutput[] {
  if (call.action === "spend") {
    const p = call.args[1] as { commitments: readonly Hex[]; ciphertexts: readonly (readonly Hex[])[] };
    return [{ commitment: p.commitments[2]!, ct: p.ciphertexts[2]! }];
  }
  if (call.action === "lockPair") return [call.args[1], call.args[3]].map((p) => (p as { relayFee: FeeOutput }).relayFee);
  if (FEE_FIELD_ACTIONS.has(call.action)) return [(call.args[1] as { relayFee: FeeOutput }).relayFee];
  return [];
}

/** Strict: exact field set, exact lengths, canonical field elements. Everything the contract would refuse later is refused here first. */
export function parseRelayRequest(action: RelayAction, body: Record<string, unknown>): RelayCall {
  for (const key of Object.keys(body)) if (key !== "proof" && key !== "publicInputs") reject(key, "is not a known field");
  if (action === "lockPair") return parseLockPair(body);
  const proof = checkProof(body.proof);
  if (action === "requestExit") {
    if (typeof body.publicInputs !== "object" || body.publicInputs === null) reject("publicInputs", "must be an object");
    const inputs = validate({ root: "field", nullifier: "field" }, body.publicInputs, "publicInputs") as { root: Hex; nullifier: Hex };
    return { action, functionName: "requestExit", args: [proof, inputs.root, inputs.nullifier], nullifiers: [] };
  }

  const inputs = validate(SHAPES[action], body.publicInputs, "publicInputs") as Record<string, unknown>;
  return { action, functionName: action, args: [proof, inputs], nullifiers: nullifiersOf(action, inputs) };
}

/** Both halves of an LP add in one call, so the contract writes the two locks at adjacent leaves (#8). */
function parseLockPair(body: Record<string, unknown>): RelayCall {
  if (!Array.isArray(body.proof) || body.proof.length !== 2) reject("proof", "must be an array of 2");
  const proofs = (body.proof as unknown[]).map((p) => checkProof(p));
  const halves = validate([lockShape, lockShape], body.publicInputs, "publicInputs") as Record<string, unknown>[];
  return { action: "lockPair", functionName: "lockPair", args: [proofs[0], halves[0], proofs[1], halves[1]], nullifiers: halves.flatMap((h) => nullifiersOf("lock", h)) };
}

/** Wallet-side: turns SDK public inputs into the JSON body. */
export function encodeRelayBody(proof: Uint8Array | readonly Uint8Array[], publicInputs: unknown): string {
  const hex = (p: Uint8Array): string => `0x${Buffer.from(p).toString("hex")}`;
  return JSON.stringify({ proof: proof instanceof Uint8Array ? hex(proof) : proof.map(hex), publicInputs }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

