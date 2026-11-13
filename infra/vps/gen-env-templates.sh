#!/usr/bin/env bash
# Writes one env-file template per service with every value blank, mode 0600. It never overwrites a file, so running it
# on a live host can't wipe a secret. Each comment names the macOS Keychain item the founder's value lives in today.
#
#   infra/vps/gen-env-templates.sh [directory]        default /etc/rooq
set -euo pipefail
DIR="${1:-/etc/rooq}"
umask 077
mkdir -p "$DIR"

put() {
  local name="$1" file="$DIR/$1.env"
  shift
  if [ -e "$file" ]; then
    echo "exists, left alone: $file"
    return
  fi
  { printf '# Rooq private service %s. Fill the values, keep this file mode 0600 and owned by root.\n# See docs/privacy/VPS_RUNBOOK.md.\n' "$name"; printf '%s\n' "$@"; } >"$file"
  chmod 600 "$file"
  echo "wrote $file"
}

put common \
  '# Shared non-key settings. RPC_URL may carry a provider API key.' \
  '# Public endpoint: https://rpc.testnet.chain.robinhood.com' \
  'RPC_URL=' \
  '# Exact web app origins, comma separated. No wildcards.' \
  'ROOQ_ALLOWED_ORIGINS=' \
  '# Proving threads per service; 4 if blank.' \
  'PROVER_THREADS='

put read-api '# Holds no keys. Nothing to fill here.'

put relayer \
  '# Keychain: rooq-private-gas-relayer' \
  'RELAYER_TX_KEY=' \
  '# Keychain: rooq-private-relayer-fee. Leave blank to accept spends without a fee note.' \
  'RELAYER_FEE_SEED=' \
  '# asset:amount,...' \
  'RELAYER_MIN_FEES='

put queue '# Keychain: rooq-private-gas-queue' 'QUEUE_TX_KEY='

put coordinator \
  '# Keychain: rooq-private-coordinator' \
  'COORDINATOR_SK=' \
  '# Key rotation only (KEY_INCIDENTS.md): retired scalars, comma separated.' \
  'COORDINATOR_SK_PREVIOUS=' \
  '# Keychain: rooq-private-gas-coordinator' \
  'COORDINATOR_TX_KEY='

for w in a b; do
  put "risk-$w" \
    "# Keychain: rooq-private-risk-$w" \
    'RISK_SK=' \
    '# Key rotation only (KEY_INCIDENTS.md): retired scalars, comma separated.' \
    'RISK_SK_PREVIOUS=' \
    "# Keychain: rooq-private-gas-risk-$w" \
    'RISK_TX_KEY=' \
    "# Keychain: rooq-private-reward-$w" \
    'RISK_REWARD_SEED=' \
    '# Seconds between routine funding updates when nothing trades. Must stay well under the one-hour limit.' \
    'RISK_EPOCH_INTERVAL_S=1800'
done

put maker \
  '# Keychain: rooq-private-maker-seed' \
  'MAKER_SEED=' \
  '# market:spreadBps:maxSizeWad:closeSpreadBps:amount:locks, comma separated.' \
  'MAKER_TERMS='

put price-relay \
  '# Keychain: rooq-private-gas-price-relay. Operator of the TEST relay feeds; test funds only.' \
  'PRICE_RELAY_TX_KEY='
