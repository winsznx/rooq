// Appends up to BATCH queued entries to the commitment tree. Needs no secrets, so anyone can process the queue.
//
// Entry kinds (ShieldedPool queue):
//   0 padding: must only follow real entries; nothing is inserted.
//   1 deposit: a = note inner, b = asset, c = value. The leaf is the FREE note commitment built here, so the
//     credited asset and amount are exactly what the contract received.
//   2 ready leaf: a = commitment already proven by a spend.
use rooq_zk::{assert_amount, assert_address, FREE_DOMAIN, merkle_root, note_commitment, TREE_DEPTH};

global BATCH: u32 = 8;

fn main(
    paths: [[Field; TREE_DEPTH]; BATCH],
    deployment: pub Field,
    old_root: pub Field,
    new_root: pub Field,
    start_index: pub Field,
    kind: pub [Field; BATCH],
    a: pub [Field; BATCH],
    b: pub [Field; BATCH],
    c: pub [Field; BATCH],
) {
    start_index.assert_max_bit_size::<TREE_DEPTH>();
    let mut root = old_root;
    let mut padding = false;
    for i in 0..BATCH {
        assert(kind[i] * (kind[i] - 1) * (kind[i] - 2) == 0, "unknown entry kind");
        if kind[i] == 0 {
            padding = true;
        } else {
            assert(!padding, "entry after padding");
            let leaf = if kind[i] == 1 {
                assert_address(b[i]);
                assert_amount(c[i]);
                note_commitment(deployment, FREE_DOMAIN, b[i], c[i], a[i])
            } else {
                a[i]
            };
            let index = start_index + i as Field;
            index.assert_max_bit_size::<TREE_DEPTH>();
            assert_eq(merkle_root(0, index, paths[i]), root, "slot not empty under current root");
            root = merkle_root(leaf, index, paths[i]);
        }
    }
    assert_eq(root, new_root);
}
