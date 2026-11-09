use bench_core::{run, Op};
use risc0_zkvm::guest::env;

fn main() {
    let op: Op = env::read();
    let journal = run(&op);
    env::commit(&journal);
}
