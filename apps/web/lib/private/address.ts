import { toHex32, type Point, type PrivateAddress, type WalletKeys } from "@rooq/private-sdk";
import { keccak256, type Hex } from "viem";

const PREFIX = "rooq1";
/** Addresses shared before the prefix became `rooq1` still decode. */
const LEGACY_PREFIXES = ["rq1"];
const checksum = (body: string): string => keccak256(`0x${body}` as Hex).slice(2, 10);

export function encodeAddress(a: { readonly auth: bigint; readonly pk: Point }): string {
  const body = [a.auth, a.pk.x, a.pk.y].map((x) => toHex32(x).slice(2)).join("");
  return `${PREFIX}${body}${checksum(body)}`;
}

export function decodeAddress(input: string): PrivateAddress {
  const s = input.trim();
  const prefix = [PREFIX, ...LEGACY_PREFIXES].find((p) => s.startsWith(p));
  if (!prefix || s.length !== prefix.length + 192 + 8 || !/^[0-9a-f]+$/.test(s.slice(prefix.length))) throw new Error("That isn't a Rooq private address.");
  const body = s.slice(prefix.length, prefix.length + 192);
  if (checksum(body) !== s.slice(prefix.length + 192)) throw new Error("That address has a typo: its checksum doesn't match.");
  const word = (i: number): bigint => BigInt(`0x${body.slice(i * 64, (i + 1) * 64)}`);
  return { auth: word(0), pk: { x: word(1), y: word(2) } };
}

export const addressOfKeys = (k: WalletKeys): string => encodeAddress({ auth: k.auth, pk: k.pk });
