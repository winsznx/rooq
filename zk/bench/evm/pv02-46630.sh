#!/usr/bin/env bash
# PV-02 experiment on Robinhood Chain testnet (46630). Needs DEPLOYER_PRIVATE_KEY in the environment (never a file).
# 1. deploys the benchmark perp_open verifier; 2. eth_call with the genuine proof (expect true);
# 3. eth_call with a flipped proof byte, a flipped public input and the transfer proof (expect revert or false).
# RPC=http://127.0.0.1:8545 runs the same steps against local anvil.
set -euo pipefail
cd "$(dirname "$0")"
RPC=${RPC:-https://rpc.testnet.chain.robinhood.com}
: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY}"
OUT=../results/pv02-$(cast chain-id --rpc-url "$RPC").txt
forge script script/DeployVerifier.s.sol --rpc-url "$RPC" --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast 2>&1 | tee "$OUT.deploy"
V=$(grep -o 'perp_open verifier 0x[0-9a-fA-F]*' "$OUT.deploy" | awk '{print $3}')
inputs() { python3 -c "import sys;d=open(sys.argv[1],'rb').read();print('['+','.join('0x'+d[i:i+32].hex() for i in range(0,len(d),32))+']')" "$1"; }
call() { cast call "$V" "verify(bytes,bytes32[])(bool)" "$1" "$2" --rpc-url "$RPC" 2>&1 | tail -1; }
P=0x$(xxd -p ../noir/out/perp_open/proof | tr -d '\n')
I=$(inputs ../noir/out/perp_open/public_inputs)
BADP=${P:0:200}$(printf '%x' $(( (0x${P:200:1} + 1) % 16 )))${P:201}
BADI=$(python3 -c "import sys;a=sys.argv[1][1:-1].split(',');a[3]=a[3][:-1]+('0' if a[3][-1]!='0' else '1');print('['+','.join(a)+']')" "$I")
TP=0x$(xxd -p ../noir/out/transfer/proof | tr -d '\n'); TI=$(inputs ../noir/out/transfer/public_inputs)
{
  echo "chain $(cast chain-id --rpc-url "$RPC") verifier $V code bytes $(cast codesize "$V" --rpc-url "$RPC")"
  echo "genuine:            $(call "$P" "$I")"
  echo "genuine gas est:    $(cast estimate "$V" "verify(bytes,bytes32[])" "$P" "$I" --rpc-url "$RPC" 2>&1 | tail -1)"
  echo "flipped proof byte: $(call "$BADP" "$I")"
  echo "flipped input:      $(call "$P" "$BADI")"
  echo "other circuit:      $(call "$TP" "$TI")"
} | tee "$OUT"
