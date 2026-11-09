/**
 * Encrypted local storage. Seeds exist on this device only if the person chose "Remember this device", and then only
 * encrypted, under a passkey (WebAuthn PRF) or a non-extractable device key. Operation records are encrypted under a key
 * derived from the account seed, so a different wallet can never read another's records. Nothing here goes to a service.
 */
const DB = "rooq-private-v2";
const STORE = "kv";

interface Blob {
  readonly iv: Uint8Array;
  readonly ct: Uint8Array;
}

export interface Remembered extends Blob {
  readonly method: "passkey" | "device";
  readonly credentialId: string | null;
  readonly accountId: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
  });
}

async function get<T>(key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB read failed"));
  });
}

async function put(key: string, value: unknown): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
  });
}

async function del(key: string): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
  });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function seal(key: CryptoKey, plain: string): Promise<Blob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plain)));
  return { iv, ct };
}

async function unseal(key: CryptoKey, blob: Blob): Promise<string> {
  return decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.iv as BufferSource }, key, blob.ct as BufferSource));
}

/** One AES key from high-entropy input, per purpose. */
async function hkdfKey(secret: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", secret as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: encoder.encode(info) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const seedBytes = (seed: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  let v = seed;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};

export const operationsKey = (seed: bigint): Promise<CryptoKey> => hkdfKey(seedBytes(seed), "rooq/operations/v1");

const rememberName = (address: string) => `remember:${address.toLowerCase()}`;
const verifiedName = (address: string) => `verified:${address.toLowerCase()}`;
const deviceKeyName = (address: string) => `device-key:${address.toLowerCase()}`;

export const loadRemembered = (address: string): Promise<Remembered | undefined> => get<Remembered>(rememberName(address));
export const isVerified = async (address: string): Promise<boolean> => (await get<boolean>(verifiedName(address))) === true;
export const markVerified = (address: string): Promise<void> => put(verifiedName(address), true);
export const forgetRemembered = (address: string): Promise<void> => del(rememberName(address));

export async function rememberWithPasskey(address: string, seed: bigint, prf: Uint8Array, credentialId: string, accountId: string): Promise<void> {
  const blob = await seal(await hkdfKey(prf, "rooq/remember/v1"), seed.toString(16));
  await put(rememberName(address), { ...blob, method: "passkey", credentialId, accountId } satisfies Remembered);
}

export async function rememberWithDeviceKey(address: string, seed: bigint, accountId: string): Promise<void> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await put(deviceKeyName(address), key);
  const blob = await seal(key, seed.toString(16));
  await put(rememberName(address), { ...blob, method: "device", credentialId: null, accountId } satisfies Remembered);
}

export async function openRemembered(address: string, prf: Uint8Array | null): Promise<bigint> {
  const record = await loadRemembered(address);
  if (!record) throw new Error("This device doesn't remember this wallet.");
  const key = record.method === "passkey" ? await hkdfKey(prf!, "rooq/remember/v1") : await get<CryptoKey>(deviceKeyName(address));
  if (!key) throw new Error("This device's key is missing. Sign with your wallet instead.");
  return BigInt(`0x${await unseal(key, record)}`);
}

export async function loadEncrypted<T>(key: CryptoKey, name: string): Promise<T | null> {
  const blob = await get<Blob>(name);
  if (!blob) return null;
  return JSON.parse(await unseal(key, blob)) as T;
}

export async function saveEncrypted(key: CryptoKey, name: string, value: unknown): Promise<void> {
  await put(name, await seal(key, JSON.stringify(value)));
}
