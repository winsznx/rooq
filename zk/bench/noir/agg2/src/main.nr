// Composition benchmark: a settlement circuit that recursively verifies two client transfer proofs
// (UltraHonk ZK, proof type 6 per barretenberg/noir/bb_proof_verification v5.3.0) and checks that their
// nullifiers are distinct. Measures the per-proof recursion cost a batch circuit pays.
global PROOF_TYPE_HONK_ZK: u32 = 6;
global ZK_PROOF_LENGTH: u32 = 458;
global VK_LENGTH: u32 = 115;
global PUBLIC_INPUTS: u32 = 11;

fn main(
    vk: [Field; VK_LENGTH],
    proofs: [[Field; ZK_PROOF_LENGTH]; 2],
    inputs: [[Field; PUBLIC_INPUTS]; 2],
    vk_hash: pub Field,
    nullifiers: pub [Field; 4],
) {
    for i in 0..2 {
        std::verify_proof_with_type(vk, proofs[i], inputs[i], vk_hash, PROOF_TYPE_HONK_ZK);
        assert_eq(nullifiers[2 * i], inputs[i][1]);
        assert_eq(nullifiers[2 * i + 1], inputs[i][2]);
    }
    for i in 0..4 {
        for j in 0..4 {
            if i < j {
                assert(nullifiers[i] != nullifiers[j]);
            }
        }
    }
}
