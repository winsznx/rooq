/**
 * Copies what the browser prover needs into public/proving: compiled circuits from zk/circuits/target and a bounded
 * slice of the BN254 CRS. Serving the CRS from this origin means proving makes no third-party requests.
 * The CRS comes from bb's local cache when present, otherwise from Aztec's CDN.
 */
import { copyFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const CIRCUITS = join(WEB, "../../zk/circuits/target");
const OUT = join(WEB, "public/proving");
/** bb.js loads this many points by default in a browser (DEFAULT_BB_CRS_SIZE). */
const CRS_POINTS = 2 ** 19;
/** bb.js always loads this many Grumpkin points (uncompressed, 64 bytes each). */
const GRUMPKIN_BYTES = 2 ** 16 * 64;
const G1_BYTES = CRS_POINTS * 32;
const CRS_CDN = "https://crs.aztec-cdn.foundation";

/** Circuits a wallet proves. append, liquidate, funding_epoch and the like belong to services. */
const WALLET_CIRCUITS = ["spend", "lock", "release", "close_pair", "pair_update", "exit_request", "redeem_claim", "lp_set"];

async function crs() {
  const g1 = join(OUT, "g1_compressed.dat");
  const g2 = join(OUT, "g2.dat");
  const grumpkin = join(OUT, "grumpkin_g1_v2.dat");
  if (existsSync(g1) && statSync(g1).size === G1_BYTES && existsSync(g2) && existsSync(grumpkin)) return;
  const local = join(homedir(), ".bb-crs");
  if (existsSync(join(local, "bn254_g1_compressed.dat")) && statSync(join(local, "bn254_g1_compressed.dat")).size >= G1_BYTES) {
    const fd = openSync(join(local, "bn254_g1_compressed.dat"), "r");
    const buf = Buffer.alloc(G1_BYTES);
    readSync(fd, buf, 0, G1_BYTES, 0);
    closeSync(fd);
    writeFileSync(g1, buf);
    copyFileSync(join(local, "bn254_g2.dat"), g2);
    copyFileSync(join(local, "grumpkin_g1_v2.flat.dat"), grumpkin);
    return;
  }
  const part = await fetch(`${CRS_CDN}/g1_compressed.dat`, { headers: { Range: `bytes=0-${G1_BYTES - 1}` } });
  if (!part.ok) throw new Error(`CRS download failed: ${part.status}`);
  writeFileSync(g1, Buffer.from(await part.arrayBuffer()));
  const g2Res = await fetch(`${CRS_CDN}/g2.dat`);
  if (!g2Res.ok) throw new Error(`CRS download failed: ${g2Res.status}`);
  writeFileSync(g2, Buffer.from(await g2Res.arrayBuffer()));
  const gr = await fetch(`${CRS_CDN}/grumpkin_g1_v2.dat`, { headers: { Range: `bytes=0-${GRUMPKIN_BYTES - 1}` } });
  if (!gr.ok) throw new Error(`CRS download failed: ${gr.status}`);
  writeFileSync(grumpkin, Buffer.from(await gr.arrayBuffer()));
}

mkdirSync(OUT, { recursive: true });
for (const name of readdirSync(CIRCUITS)) {
  if (name.endsWith(".json") && WALLET_CIRCUITS.includes(name.replace(".json", ""))) copyFileSync(join(CIRCUITS, name), join(OUT, name));
}
await crs();
console.log(`proving assets ready in ${OUT}`);
