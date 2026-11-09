/** Checks each `rooq@` unit on this host against its loopback /health. Only public health fields are printed. */
import { execFileSync } from "node:child_process";

const OFFSET: Readonly<Record<string, number>> = { "read-api": 0, relayer: 1, queue: 2, coordinator: 3, "risk-a": 4, "risk-b": 5, maker: 6, "price-relay": 7 };
const BASE = Number(process.env.PRIVATE_BASE_PORT ?? 8710);

interface Health {
  readonly status: string;
  readonly lagBlocks: number | null;
  readonly blocked: string | null;
  readonly lastError: { readonly message: string } | null;
  readonly feeds?: readonly { readonly symbol: string; readonly ageSeconds: number; readonly fresh: boolean; readonly lastSkip: string | null }[];
  readonly gasBalanceWei?: string;
}

function units(): { name: string; active: string }[] {
  const out = execFileSync("systemctl", ["list-units", "--all", "--plain", "--no-legend", "--type=service", "rooq@*"], { encoding: "utf8" });
  return out.trim().split("\n").filter((l) => l !== "").map((l) => {
    const [unit = "", , active = "", sub = ""] = l.split(/\s+/);
    return { name: unit.replace(/^rooq@/, "").replace(/\.service$/, ""), active: `${active}/${sub}` };
  });
}

async function health(name: string): Promise<{ http: number; body: Health | null }> {
  const res = await fetch(`http://127.0.0.1:${BASE + (OFFSET[name] ?? 0)}/health`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!res) return { http: 0, body: null };
  return { http: res.status, body: (await res.json()) as Health };
}

let bad = 0;
const found = units();
if (found.length === 0) {
  console.log("no rooq@ units found");
  process.exit(1);
}
for (const { name, active } of found) {
  const { http, body } = await health(name);
  const ok = active.startsWith("active") && http === 200 && body?.blocked === null;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(12)} ${active.padEnd(16)} http=${http} status=${body?.status ?? "-"} lag=${body?.lagBlocks ?? "-"} blocked=${body?.blocked ?? "-"}${body?.lastError ? ` error=${body.lastError.message}` : ""}`);
  for (const f of body?.feeds ?? []) console.log(`       ${f.symbol.padEnd(5)} age=${f.ageSeconds}s fresh=${f.fresh}${f.lastSkip ? ` skip=${f.lastSkip}` : ""}`);
  if (body?.gasBalanceWei) console.log(`       relay gas balance ${body.gasBalanceWei} wei`);
}
process.exit(bad === 0 ? 0 : 1);
