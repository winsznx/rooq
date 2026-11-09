import { BarretenbergSync, GRUMPKIN_G1_GENERATOR } from "@aztec/bb.js";
import { fromBytes, toBytes32 } from "./field";

/** A Grumpkin point (affine). Coordinates are BN254 field elements. */
export interface Point {
  readonly x: bigint;
  readonly y: bigint;
}

let api: BarretenbergSync | null = null;

/** Loads Barretenberg's WASM. Must run once before any hashing or key derivation. */
export async function initCrypto(): Promise<void> {
  api ??= await BarretenbergSync.initSingleton();
}

function bb(): BarretenbergSync {
  if (!api) throw new Error("initCrypto() has not been awaited");
  return api;
}

/** Poseidon2 sponge, identical to `Poseidon2::hash(input, input.len())` in the circuits. */
export function hash(inputs: readonly bigint[]): bigint {
  return fromBytes(bb().poseidon2Hash({ inputs: inputs.map(toBytes32) }).hash);
}

const G = GRUMPKIN_G1_GENERATOR;

export function mulGenerator(scalar: bigint): Point {
  return mul({ x: fromBytes(G.x), y: fromBytes(G.y) }, scalar);
}

export function mul(p: Point, scalar: bigint): Point {
  const r = bb().grumpkinMul({ point: { x: toBytes32(p.x), y: toBytes32(p.y) }, scalar: toBytes32(scalar) }).point;
  return { x: fromBytes(r.x), y: fromBytes(r.y) };
}

/** Grumpkin: y^2 = x^3 - 17 over the BN254 scalar field. */
export function isOnCurve(p: Point): boolean {
  const F = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  return (p.y * p.y) % F === (((p.x * p.x) % F) * p.x - 17n + F) % F;
}
