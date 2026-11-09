//! Proves the ADR-P03 benchmark statements with RISC Zero and records timings.
//! Usage: host <transfer|perp_open> <composite|succinct|groth16> [runs]
use std::time::Instant;

use bench_core::*;
use k256::ecdsa::SigningKey;
use methods::{ROOQ_BENCH_GUEST_ELF, ROOQ_BENCH_GUEST_ID};
use risc0_zkvm::{default_prover, ExecutorEnv, ProverOpts, VerifierContext};

fn usdg() -> W {
    let mut a = [0u8; 32];
    a[12..].copy_from_slice(&hex::decode("7e955252e15c84f5768b83c41a71f9eba181802f").unwrap());
    a
}

fn w(x: u128) -> W {
    word(x)
}

fn filler_path(sibling: W) -> [W; TREE_DEPTH] {
    let mut p = [[0u8; 32]; TREE_DEPTH];
    p[0] = sibling;
    for (i, s) in p.iter_mut().enumerate().skip(1) {
        *s = h(99, &[&(i as u32).to_be_bytes()]);
    }
    p
}

fn transfer_witness() -> TransferWitness {
    let deployment = w(46630);
    let domain = w(0);
    let asset = usdg();
    let sk = w(0x1234);
    let enc_sk = w(0x5678);
    let owner = owner_tag(&h(T_AUTH, &[&sk]), &enc_pubkey(&enc_sk));
    let in_values = [600_000u128, 400_000];
    let in_rho = [w(11), w(12)];
    let in_blind = [w(21), w(22)];
    let cm = |i: usize| Note { domain, asset, value: in_values[i], owner, rho: in_rho[i], blind: in_blind[i] }.commit(&deployment);
    let (cm0, cm1) = (cm(0), cm(1));
    let recipient_pk = enc_pubkey(&w(0x9abc));
    TransferWitness {
        sk, enc_sk, in_values, in_rho, in_blind, in_index: [0, 1], in_path: [filler_path(cm1), filler_path(cm0)],
        outs: [
            TransferOutput { value: 700_000, recipient_auth: h(T_AUTH, &[&w(0xdef0)]), recipient_pk, rho: w(31), blind: w(41), eph: w(51) },
            TransferOutput { value: 299_000, recipient_auth: h(T_AUTH, &[&sk]), recipient_pk: enc_pubkey(&enc_sk), rho: w(32), blind: w(42), eph: w(52) },
        ],
        deployment, domain, asset, fee: 1_000,
    }
}

fn perp_witness() -> PerpWitness {
    // anvil account 1: public test key.
    let maker_key = SigningKey::from_slice(&hex::decode("59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d").unwrap()).unwrap();
    let maker_pubkey = maker_key.verifying_key().to_encoded_point(false).as_bytes().to_vec();
    let mut maker = [0u8; 20];
    maker.copy_from_slice(&keccak(&maker_pubkey[1..])[12..]);
    let params = PerpParams {
        batch_time: 1_800_000_000, domain_separator: w(0x0badc0de), deployment: w(46630), policy_version: 1,
        risk_pk: enc_pubkey(&w(0x7777)), market: w(0x5453_4c41), collateral: usdg(),
        imr_bps: 1_000, fee_bps: 10, max_dev_bps: 100,
    };
    let sk = w(0x1234);
    let enc_sk = w(0x5678);
    let taker_owner = owner_tag(&h(T_AUTH, &[&sk]), &enc_pubkey(&enc_sk));
    let maker_owner = h(T_MAKER, &[&maker]);
    let quote = Quote { maker, size_abs: 10_000_000_000_000_000_000, is_long: true, price: 400_000_000_000_000_000_000, min_fill: 0, nonce: 7, deadline: 1_800_000_030 };
    let taker_cm = Note { domain: w(FREE_DOMAIN), asset: params.collateral, value: 1_000_000_000, owner: taker_owner, rho: w(11), blind: w(21) }.commit(&params.deployment);
    let maker_cm = Note { domain: params.market, asset: params.collateral, value: 5_000_000_000, owner: maker_owner, rho: w(12), blind: w(22) }.commit(&params.deployment);
    let digest = quote_digest(&params, &h(T_TAKER, &[&taker_owner]), &quote);
    let (sig, _) = maker_key.sign_prehash_recoverable(&digest).unwrap();
    PerpWitness {
        sk, enc_sk, taker_value: 1_000_000_000, taker_rho: w(11), taker_blind: w(21), taker_index: 0, taker_path: filler_path(maker_cm),
        maker_value: 5_000_000_000, maker_rho: w(12), maker_blind: w(22), maker_rec_nonce: w(33), maker_index: 1, maker_path: filler_path(taker_cm),
        oracle_price: 401_000_000_000_000_000_000, oracle_epoch: 900, taker_margin: 500_000_000, maker_margin: 500_000_000,
        funding_snapshot: w(0), pair_nonce: w(44), pair_blind: w(45), change_rho: w(46), change_blind: w(47),
        maker_change_rho: w(48), maker_change_blind: w(49), fee_rho: w(50), fee_blind: w(51), eph_risk: w(52), eph_owner: w(53),
        quote, maker_pubkey, signature: sig.to_bytes().to_vec(), params,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let op_name = args.get(1).map(String::as_str).unwrap_or("transfer");
    let mode = args.get(2).map(String::as_str).unwrap_or("succinct");
    let runs: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(1);
    let op = match op_name {
        "transfer" => Op::Transfer(transfer_witness()),
        "perp_open" => Op::PerpOpen(perp_witness()),
        other => panic!("unknown op {other}"),
    };
    let expected = run(&op);
    let opts = match mode {
        "composite" => ProverOpts::composite(),
        "succinct" => ProverOpts::succinct(),
        "groth16" => ProverOpts::groth16(),
        other => panic!("unknown mode {other}"),
    };
    for i in 0..runs {
        let env = ExecutorEnv::builder().write(&op).unwrap().build().unwrap();
        let t = Instant::now();
        let info = default_prover().prove_with_ctx(env, &VerifierContext::default(), ROOQ_BENCH_GUEST_ELF, &opts).unwrap();
        let secs = t.elapsed().as_secs_f64();
        let receipt = info.receipt;
        receipt.verify(ROOQ_BENCH_GUEST_ID).unwrap();
        let journal: Journal = receipt.journal.decode().unwrap();
        assert_eq!(journal, expected, "journal mismatch");
        let seal_len = bincode_len(&receipt);
        println!(
            "RESULT op={op_name} mode={mode} run={i} prove_s={secs:.2} user_cycles={} total_cycles={} segments={} receipt_bytes={seal_len} journal_bytes={}",
            info.stats.user_cycles, info.stats.total_cycles, info.stats.segments, receipt.journal.bytes.len()
        );
        if mode == "groth16" {
            let g = receipt.inner.groth16().unwrap();
            std::fs::create_dir_all("out").unwrap();
            std::fs::write(format!("out/{op_name}.seal"), &g.seal).unwrap();
            std::fs::write(format!("out/{op_name}.journal"), &receipt.journal.bytes).unwrap();
            std::fs::write(format!("out/{op_name}.claim_digest"), hex::encode(risc0_zkvm::sha::Digestible::digest(&receipt.claim().unwrap()).as_bytes())).unwrap();
        }
    }
    // Byte order the EVM verifier expects (Digest bytes), not the u32 words.
    println!("IMAGE_ID 0x{}", hex::encode(risc0_zkvm::sha::Digest::from(ROOQ_BENCH_GUEST_ID).as_bytes()));
}

fn bincode_len(r: &risc0_zkvm::Receipt) -> usize {
    match &r.inner {
        risc0_zkvm::InnerReceipt::Groth16(g) => g.seal.len(),
        risc0_zkvm::InnerReceipt::Succinct(s) => s.seal.len() * 4,
        risc0_zkvm::InnerReceipt::Composite(c) => c.segments.iter().map(|s| s.seal.len() * 4).sum(),
        _ => 0,
    }
}
