import { ENV, RPC_URL } from "@/lib/env";

/** The private stack. Local defaults match `pnpm --filter @rooq/private-services start:local`. */
export const PRIVATE_READ_URL = process.env.NEXT_PUBLIC_PRIVATE_READ_URL ?? "http://127.0.0.1:8710";
export const PRIVATE_RELAYER_URL = process.env.NEXT_PUBLIC_PRIVATE_RELAYER_URL ?? "http://127.0.0.1:8711";
export const PRIVATE_RPC_URL = process.env.NEXT_PUBLIC_PRIVATE_RPC_URL ?? (ENV === "local" ? "http://127.0.0.1:8548" : RPC_URL);
