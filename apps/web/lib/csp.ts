const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8700/api/v1";
const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";
const MAKER = process.env.NEXT_PUBLIC_MAKER_URL ?? "http://127.0.0.1:8701";
const READ = process.env.NEXT_PUBLIC_PRIVATE_READ_URL ?? "http://127.0.0.1:8710";
const RELAYER = process.env.NEXT_PUBLIC_PRIVATE_RELAYER_URL ?? "http://127.0.0.1:8711";
const PRIVATE_RPC = process.env.NEXT_PUBLIC_PRIVATE_RPC_URL ?? "http://127.0.0.1:8548";

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export function connectSources(isDev: boolean): string[] {
  return ["'self'", origin(API), origin(RPC), origin(MAKER), origin(READ), origin(RELAYER), origin(PRIVATE_RPC), "data:", "https://rpc.testnet.chain.robinhood.com", "https://explorer.testnet.chain.robinhood.com", isDev ? "ws://localhost:*" : ""].filter(Boolean);
}

/** No third-party script origin may run near key handling, and only scripts this response nonces may start. */
export function appCsp(nonce: string, inlineHash: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic' '${inlineHash}' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connectSources(isDev).join(" ")}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
