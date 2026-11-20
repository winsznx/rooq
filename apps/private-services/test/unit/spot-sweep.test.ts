import { describe, expect, test } from "bun:test";
import { initCrypto, KeyRing, mulGenerator, POOL_CT_LEN } from "@rooq/private-sdk";
import { SpotExecutor } from "../../src/lib/spot-exec";

describe("protocol fee sweep (re-audit)", () => {
  test("a pool no held key opens is skipped once per interval and never aborts the tick", async () => {
    await initCrypto();
    const warnings: string[] = [];
    let reads = 0;
    const ctx = {
      chain: { spotPools: [{ id: 1n, token0: 1n, token1: 2n, feeBps: 30n, protocolBps: 0n }], deploymentId: 7n, coordinator: { x: 1n, y: 2n }, riskKeys: [{ x: 1n, y: 2n }, { x: 1n, y: 2n }] },
      ledger: {
        latestSpotUpdate: () => {
          reads++;
          const e = mulGenerator(9n);
          const slot = [e.x, e.y, ...Array.from({ length: POOL_CT_LEN - 2 }, () => 5n)];
          return { head: 123n, ciphertext: [...slot, ...slot, ...slot] };
        },
      },
      log: { warn: (event: string) => warnings.push(event), info() {}, debug() {} },
    };
    const executor = new SpotExecutor(ctx as never, new KeyRing([12345n]), 0, 1, {} as never, {} as never);
    expect(executor.retiredKeyRecords(0, 0n).unreadable).toBe(1);
    await expect(executor.sweepProtocolFees()).resolves.toBeUndefined();
    await expect(executor.sweepProtocolFees()).resolves.toBeUndefined();
    expect(warnings).toEqual(["sweep_protocol_pool_unreadable"]);
    expect(reads).toBe(2);
  });
});
