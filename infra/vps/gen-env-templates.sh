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
  '# Minimum relay fees, comma separated: asset:amount for every action with a fee output, or action:asset:amount for one' \
  '# action. Leave blank to make every relay fee zero (testnet).' \
  'RELAYER_MIN_FEES=' \
  '# Keychain: rooq-private-relayer-service-token. The maker sends the same value so its own traffic is not charged.' \
  'RELAYER_SERVICE_TOKEN='

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
  'MAKER_TERMS=' \
  '# Keychain: rooq-private-relayer-service-token. Same value as the relayer'"'"'s RELAYER_SERVICE_TOKEN.' \
  'MAKER_RELAYER_TOKEN=' \
  '# The relayer the maker posts locks to. Must be https or loopback while MAKER_RELAYER_TOKEN is set.' \
  'MAKER_RELAYER_URL='

put price-relay \
  '# Keychain: rooq-private-gas-price-relay. Operator of the TEST relay feeds; test funds only.' \
  'PRICE_RELAY_TX_KEY='

put analytics \
  '# Keychain: rooq-private-admin-token. The bearer token for /v1/admin/*; Vercel rooq-web holds the same value.' \
  'ADMIN_API_TOKEN=' \
  "# Rooq's own wallets, shown by label in the admin. Public, not secret: label:address, comma separated." \
  'ADMIN_OPERATORS=' \
  '# Blocks behind head left unindexed so a reorg cannot rewrite counted rows; 64 if blank.' \
  'FINALITY_BLOCKS=' \
  '# ANALYTICS_DB_PATH and ANALYTICS_HEALTH_URLS come from the rooq@analytics drop-ins. A line here, even blank, would override them.'
