import { describe, expect, test } from "bun:test";
import { createPublicClient, custom, encodeAbiParameters, http, type Address } from "viem";
import { foundry } from "viem/chains";
import { readTokenDecimals } from "../src/meta";

const TOKEN: Address = "0x00000000000000000000000000000000000000aa";

function clientAnswering(ethCall: () => unknown) {
  return createPublicClient({
    chain: foundry,
    transport: custom({
      request: async ({ method }: { method: string }) => {
        if (method === "eth_call") return ethCall();
        throw new Error(`unexpected ${method}`);
      },
    }),
  });
}

describe("readTokenDecimals", () => {
  test("returns decimals a token reports within range", async () => {
    const client = clientAnswering(() => encodeAbiParameters([{ type: "uint8" }], [6]));
    expect(await readTokenDecimals(client, TOKEN)).toBe(6);
  });

  test("skips a token reporting more than 18 decimals", async () => {
    const client = clientAnswering(() => encodeAbiParameters([{ type: "uint8" }], [19]));
    expect(await readTokenDecimals(client, TOKEN)).toBeNull();
  });

  test("skips a token whose decimals() reverts instead of halting the indexer", async () => {
    // #given a permissionless pool token that reverts on decimals()
    const client = clientAnswering(() => {
      throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
    });
    // #when / #then
    expect(await readTokenDecimals(client, TOKEN)).toBeNull();
  });

  test("skips an address that returns no data", async () => {
    const client = clientAnswering(() => "0x");
    expect(await readTokenDecimals(client, TOKEN)).toBeNull();
  });

  test("rethrows when the RPC itself is unreachable so the batch retries", async () => {
    const client = createPublicClient({ chain: foundry, transport: http("http://127.0.0.1:9", { retryCount: 0 }) });
    await expect(readTokenDecimals(client, TOKEN)).rejects.toThrow();
  });
});
