#!/usr/bin/env bash
# Each case changes one value in a valid Prover.toml; witness generation must fail (no proof can exist).
set -uo pipefail
cd "$(dirname "$0")"
pass=0; fail=0
case_() { # name package sed-expression
  local name=$1 pkg=$2 expr=$3
  cp "$pkg/Prover.toml" "$pkg/Prover.toml.bak"
  sed -i '' -E "$expr" "$pkg/Prover.toml"
  if cmp -s "$pkg/Prover.toml" "$pkg/Prover.toml.bak"; then echo "SETUP-ERROR $name: substitution did not apply"; fail=$((fail+1));
  elif nargo execute --package "$pkg" >/dev/null 2>&1; then echo "ACCEPTED (bad) $name"; fail=$((fail+1));
  else echo "rejected $name"; pass=$((pass+1)); fi
  mv "$pkg/Prover.toml.bak" "$pkg/Prover.toml"
}
case_ "transfer: wrong spending key"            transfer 's/^sk = "0x1234"/sk = "0x1235"/'
case_ "transfer: inflate output value"          transfer 's/^fee = "0x03e8"/fee = "0x03e7"/'
case_ "transfer: forged nullifier"              transfer 's/^nf = \["0x0/nf = ["0x1/'
case_ "transfer: wrong root"                    transfer 's/^root = "0x1/root = "0x2/'
case_ "transfer: other deployment"              transfer 's/^deployment = "0xb626"/deployment = "0xb627"/'
case_ "transfer: ciphertext for wrong key"      transfer 's/^ct_hash = \["0x/ct_hash = ["0x1/'
case_ "perp: quote expired at batch time"       perp_open 's/^batch_time = "0x[0-9a-f]+"/batch_time = "0x6b49d21f"/'
case_ "perp: other chain domain separator"      perp_open 's/^domain_separator = "0x0badc0de"/domain_separator = "0x0badc0df"/'
case_ "perp: changed policy version"            perp_open 's/^policy_version = "0x01"/policy_version = "0x02"/'
case_ "perp: price changed after signing"       perp_open 's/price = "0x15af1d78b58c400000"/price = "0x15af1d78b58c400001"/'
case_ "perp: size changed after signing"        perp_open 's/size_abs = "0x8ac7230489e80000"/size_abs = "0x8ac7230489e80001"/'
case_ "perp: side flipped after signing"        perp_open 's/is_long = true/is_long = false/'
case_ "perp: taker margin below IMR"            perp_open 's/taker_margin = "0x1dcd6500"/taker_margin = "0x17c841c0"/'
case_ "perp: maker margin below IMR"            perp_open 's/maker_margin = "0x1dcd6500"/maker_margin = "0x17c841c0"/'
case_ "perp: oracle commitment for other epoch" perp_open 's/oracle_epoch = "0x0384"/oracle_epoch = "0x0385"/'
case_ "perp: forged signature byte"             perp_open 's/signature = \[([0-9]+),/signature = [7,/'
case_ "perp: maker record nonce reused wrong"   perp_open 's/maker_rec_nonce = "0x21"/maker_rec_nonce = "0x22"/'
case_ "perp: risk ciphertext mismatch"          perp_open 's/^ct_pair_risk = "0x0e/ct_pair_risk = "0x0f/'
case_ "perp: other risk key"                    perp_open 's/^risk_pk = \{ x = "0x0f/risk_pk = { x = "0x1f/'
echo "rejected=$pass problems=$fail"
[ "$fail" -eq 0 ]
