import { describe, expect, it } from "vitest";
import { ACTIVE_TESTNET_PIN, deploymentIdOf, deploymentMismatch, isPlaceholderPin, TESTNET_PINS, TESTNET_PRIVATE_DEPLOYMENT as PIN, type AnnouncedDeployment } from "../lib/private/deployment-pin";

const ATTACKER = "0x000000000000000000000000000000000000dEaD" as const;
const honest: AnnouncedDeployment = { pool: PIN.pool, spot: PIN.spot, asset: PIN.asset, deploymentId: PIN.deploymentId.toString() };

describe("pinned private deployment (audit finding 2)", () => {
  it("matches contracts/deployments/privacy-46630.json", () => {
    expect(deploymentIdOf(PIN.chainId, PIN.pool)).toBe(PIN.deploymentId);
  });

  it("accepts the read API when it names the pinned deployment", () => {
    expect(deploymentMismatch(honest, PIN, 46630)).toBeNull();
  });

  it("refuses a read API that redirects shields to a self-consistent attacker contract", () => {
    // #given a hostile /v1/deployment with a pool and a matching (chainId << 160) | pool id
    const hostile = { ...honest, pool: ATTACKER, deploymentId: deploymentIdOf(46630, ATTACKER).toString() };
    // #when the wallet checks it against the build's pin
    // #then it names the pool as the mismatch
    expect(deploymentMismatch(hostile, PIN, 46630)).toBe("pool");
  });

  it("refuses a different spot module or collateral asset", () => {
    expect([deploymentMismatch({ ...honest, spot: ATTACKER }, PIN, 46630), deploymentMismatch({ ...honest, asset: ATTACKER }, PIN, 46630)]).toEqual(["spot", "asset"]);
  });

  it("refuses the pinned build on another chain", () => {
    expect(deploymentMismatch(honest, PIN, 31337)).toBe("chain");
  });

  it("without a pin, still requires the id to belong to the announced pool", () => {
    expect(deploymentMismatch({ ...honest, pool: ATTACKER }, null, 31337)).toBe("deploymentId");
  });
});

describe("deployment pin selection (M36 redeploy)", () => {
  it("serves the M36 deployment, recorded in contracts/deployments/privacy-46630.json", () => {
    expect(deploymentIdOf(TESTNET_PINS.m36.chainId, TESTNET_PINS.m36.pool)).toBe(TESTNET_PINS.m36.deploymentId);
    expect([TESTNET_PINS.m36.recordVersion, TESTNET_PINS.m36.accountDerivation]).toEqual([2, 2]);
    expect(TESTNET_PINS[ACTIVE_TESTNET_PIN]).toBe(TESTNET_PINS.m36);
  });

  it("never activates a pin that still has placeholder addresses", () => {
    // #given whichever pin the constant selects #then it names a real deployment
    expect(isPlaceholderPin(TESTNET_PINS[ACTIVE_TESTNET_PIN])).toBe(false);
  });

  it("reads the current deployment with v1 records and v1 account derivation", () => {
    expect([PIN.recordVersion, PIN.accountDerivation]).toEqual([1, 1]);
  });

  it("opens new-deployment accounts with derivation 2 and reads v2 records", () => {
    expect([TESTNET_PINS.m36.accountDerivation, TESTNET_PINS.m36.recordVersion, TESTNET_PINS.m36.chainId]).toEqual([2, 2, 46630]);
  });

  it("refuses every read API while the new pin is a placeholder", () => {
    expect(deploymentMismatch(honest, TESTNET_PINS.m36, 46630)).not.toBeNull();
  });
});
