/** Prints the Grumpkin public coordinates for scalars read from the environment. Never prints a scalar. */
import { deriveKeys, initCrypto, mulGenerator } from "@rooq/private-sdk";

await initCrypto();
for (const name of ["COORDINATOR", "RISK_A", "RISK_B"]) {
  const scalar = process.env[`${name}_SK`];
  if (!scalar) throw new Error(`${name}_SK is not set`);
  const p = mulGenerator(BigInt(scalar));
  console.log(`export ${name}_X=${p.x} ${name}_Y=${p.y}`);
}

const feeSeed = process.env.FEE_SEED;
if (!feeSeed) throw new Error("FEE_SEED is not set");
const fee = deriveKeys(BigInt(feeSeed));
console.log(`export FEE_AUTH=${fee.auth} FEE_X=${fee.pk.x} FEE_Y=${fee.pk.y}`);
