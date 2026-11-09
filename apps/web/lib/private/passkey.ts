"use client";

/**
 * WebAuthn PRF, for page context only (a worker has no navigator.credentials). The PRF output goes straight to the
 * wallet worker. PRF is supported unevenly, so every caller handles `PasskeyUnsupported`.
 */
export class PasskeyUnsupported extends Error {
  constructor() {
    super("This browser or passkey doesn't support what Rooq needs. Use your wallet instead.");
  }
}

const REMEMBER_SALT = new TextEncoder().encode("rooq/passkey-salt/remember/v1");
const SEED_SALT = new TextEncoder().encode("rooq/passkey-salt/seed/v1");
export type PasskeyPurpose = "remember" | "seed";
const salt = (p: PasskeyPurpose) => (p === "remember" ? REMEMBER_SALT : SEED_SALT);

export function passkeysAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";
}

const toB64 = (b: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export interface PasskeyResult {
  readonly credentialId: string;
  readonly output: Uint8Array;
}

type PrfExtensionOutput = AuthenticationExtensionsClientOutputs & { prf?: { enabled?: boolean; results?: { first?: BufferSource } } };

function prfOf(c: PublicKeyCredential): Uint8Array | null {
  const first = (c.getClientExtensionResults() as PrfExtensionOutput).prf?.results?.first;
  if (!first) return null;
  return new Uint8Array(first instanceof ArrayBuffer ? first : (first as ArrayBufferView).buffer as ArrayBuffer);
}

export async function createPasskey(label: string, purpose: PasskeyPurpose): Promise<PasskeyResult> {
  if (!passkeysAvailable()) throw new PasskeyUnsupported();
  const options: PublicKeyCredentialCreationOptions = {
    rp: { name: "Rooq", id: location.hostname },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: label, displayName: label },
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    extensions: { prf: { eval: { first: salt(purpose) } } } as AuthenticationExtensionsClientInputs,
  };
  const created = (await navigator.credentials.create({ publicKey: options })) as PublicKeyCredential | null;
  if (!created) throw new PasskeyUnsupported();
  const credentialId = toB64(created.rawId);
  const immediate = prfOf(created);
  if (immediate) return { credentialId, output: immediate };
  if (!(created.getClientExtensionResults() as PrfExtensionOutput).prf?.enabled) throw new PasskeyUnsupported();
  return assertPasskey(credentialId, purpose);
}

/** With a credential id: that passkey. Without: any synced Rooq passkey the person picks (new device restore). */
export async function assertPasskey(credentialId: string | null, purpose: PasskeyPurpose): Promise<PasskeyResult> {
  if (!passkeysAvailable()) throw new PasskeyUnsupported();
  const options: PublicKeyCredentialRequestOptions = {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rpId: location.hostname,
    userVerification: "required",
    allowCredentials: credentialId ? [{ type: "public-key", id: fromB64(credentialId) as BufferSource }] : [],
    extensions: { prf: { eval: { first: salt(purpose) } } } as AuthenticationExtensionsClientInputs,
  };
  const got = (await navigator.credentials.get({ publicKey: options })) as PublicKeyCredential | null;
  if (!got) throw new PasskeyUnsupported();
  const output = prfOf(got);
  if (!output) throw new PasskeyUnsupported();
  return { credentialId: toB64(got.rawId), output };
}
