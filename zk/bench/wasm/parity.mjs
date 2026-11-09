import { BarretenbergSync, GRUMPKIN_G1_GENERATOR } from "@aztec/bb.js";
const bb = await BarretenbergSync.initSingleton();
const fr = (n) => { const b = new Uint8Array(32); let x = BigInt(n); for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const h = (xs) => hex(bb.poseidon2Hash({ inputs: xs.map(fr) }).hash);
const G = GRUMPKIN_G1_GENERATOR;
const g = bb.grumpkinMul({ point: G, scalar: fr(0x5678) }).point;
const s = bb.grumpkinMul({ point: g, scalar: fr(52) }).point;
console.log("P", h([1, 2]), h([4, 46630, 0, 7, 600000, 99]), hex(g.x), hex(g.y), hex(s.x));
