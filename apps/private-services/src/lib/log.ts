/**
 * Structured one-line JSON logs, as in apps/api and apps/indexer. Callers pass counts, reasons, block numbers and public
 * transaction hashes only. This is a deliberately small backstop that drops any field whose name could carry a secret.
 */
const DEBUG = process.env.LOG_LEVEL === "debug";
const FORBIDDEN_FIELD = /(^|_)(sk|seed|secret|key|mnemonic|witness|plaintext|proof|ciphertext|ip|address|path)($|_)/i;

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, error: unknown, fields?: Record<string, unknown>): void;
}

function clean(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([k]) => !FORBIDDEN_FIELD.test(k)));
}

/** Long hex runs in an error message can only be keys, witnesses or calldata, so they never reach a log line. */
export function scrubMessage(message: string): string {
  return message.replace(/0x[0-9a-fA-F]{16,}/g, "<hex>").replace(/\b\d{32,}\b/g, "<num>").slice(0, 300);
}

export function errorMessage(error: unknown): string {
  return scrubMessage(error instanceof Error ? error.message.split("\n")[0] ?? error.name : String(error));
}

export function createLogger(service: string): Logger {
  const write = (level: string, event: string, fields: Record<string, unknown>): string =>
    JSON.stringify({ t: new Date().toISOString(), service, level, event, ...clean(fields) }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  return {
    info: (event, fields = {}) => console.log(write("info", event, fields)),
    debug: (event, fields = {}) => {
      if (DEBUG) console.log(write("debug", event, fields));
    },
    warn: (event, fields = {}) => console.warn(write("warn", event, fields)),
    error: (event, error, fields = {}) => console.error(write("error", event, { ...fields, error: errorMessage(error), name: error instanceof Error ? error.name : "unknown" })),
  };
}
