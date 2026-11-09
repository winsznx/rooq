const DEBUG = process.env.LOG_LEVEL === "debug";

function line(level: string, event: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ t: new Date().toISOString(), service: "api", level, event, ...fields }, (_k, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(line("info", event, fields));
}

export function debug(event: string, fields: Record<string, unknown> = {}): void {
  if (DEBUG) console.log(line("debug", event, fields));
}

export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  const detail = error instanceof Error ? { error: error.message, name: error.name } : { error: String(error) };
  console.error(line("error", event, { ...fields, ...detail }));
}
