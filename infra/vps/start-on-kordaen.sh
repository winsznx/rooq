#!/usr/bin/env bash
# Run on the founder's Mac after install-release.sh. Copies each service's keys from the macOS Keychain into its own
# root-only env file on kordaen, caps the stack's CPU and memory, starts it, and routes api.rooq.trade through the
# shared Caddy. Key values travel over stdin on SSH and are never printed or stored anywhere else.
#
# Safe to run twice: env files are only filled if empty, and each Caddy route is only added once.
set -euo pipefail

# Rooq's own wallets for the admin, label:address comma separated. Public, not secret. Set it before running, e.g.
#   ADMIN_OPERATORS="deployer:0x...,price-relay:0x..." infra/vps/start-on-kordaen.sh
ADMIN_OPERATORS="${ADMIN_OPERATORS:-}"

kc() { security find-generic-password -s "$1" -w; }
put() {
  if ssh kordaen "sudo grep -q '^$2=.' /etc/rooq/$1.env"; then return 0; fi
  printf '%s=%s\n' "$2" "$(kc "$3")" | ssh kordaen "sudo tee -a /etc/rooq/$1.env >/dev/null"
}

if ! ssh kordaen "sudo grep -q '^RPC_URL=.' /etc/rooq/common.env"; then
  printf 'RPC_URL=https://rpc.testnet.chain.robinhood.com\nROOQ_ALLOWED_ORIGINS=https://rooq.trade,https://www.rooq.trade\nPROVER_THREADS=2\n' |
    ssh kordaen 'sudo tee -a /etc/rooq/common.env >/dev/null'
fi
put relayer RELAYER_TX_KEY rooq-private-gas-relayer
put relayer RELAYER_FEE_SEED rooq-private-relayer-fee
put relayer RELAYER_SERVICE_TOKEN rooq-private-relayer-service-token
put queue QUEUE_TX_KEY rooq-private-gas-queue
put coordinator COORDINATOR_SK rooq-private-coordinator
put coordinator COORDINATOR_TX_KEY rooq-private-gas-coordinator
for w in a b; do
  put "risk-$w" RISK_SK "rooq-private-risk-$w"
  put "risk-$w" RISK_TX_KEY "rooq-private-gas-risk-$w"
  put "risk-$w" RISK_REWARD_SEED "rooq-private-reward-$w"
done
put maker MAKER_SEED rooq-private-maker-seed
put maker MAKER_RELAYER_TOKEN rooq-private-relayer-service-token
# The relayer listens on the Docker bridge here, not loopback, and the maker refuses to send its token over plain http
# off loopback, so it reaches the relayer through Caddy.
if ! ssh kordaen "sudo grep -q '^MAKER_RELAYER_URL=.' /etc/rooq/maker.env"; then
  printf 'MAKER_RELAYER_URL=https://api.rooq.trade\n' | ssh kordaen 'sudo tee -a /etc/rooq/maker.env >/dev/null'
fi
put price-relay PRICE_RELAY_TX_KEY rooq-private-gas-price-relay
put analytics ADMIN_API_TOKEN rooq-private-admin-token
if ! ssh kordaen "sudo grep -q '^ADMIN_OPERATORS=.' /etc/rooq/analytics.env"; then
  if [ -n "$ADMIN_OPERATORS" ]; then
    printf 'ADMIN_OPERATORS=%s\n' "$ADMIN_OPERATORS" | ssh kordaen 'sudo tee -a /etc/rooq/analytics.env >/dev/null'
  else
    echo "ADMIN_OPERATORS is empty, so the admin counts Rooq's own wallets as public wallets until it is set" >&2
  fi
fi

ssh kordaen 'bash -s' <<'REMOTE'
set -euo pipefail
sudo tee /etc/systemd/system/rooq.slice >/dev/null <<E
[Unit]
Description=Rooq private services, capped so proving leaves room for the other projects on this host
[Slice]
CPUQuota=400%
MemoryMax=5G
E
sudo install -d /etc/systemd/system/rooq@.service.d /etc/systemd/system/rooq@read-api.service.d /etc/systemd/system/rooq@relayer.service.d \
  /etc/systemd/system/rooq@analytics.service.d
sudo tee /etc/systemd/system/rooq@.service.d/limits.conf >/dev/null <<E
[Service]
Slice=rooq.slice
CPUQuota=200%
MemoryMax=2G
E
# The shared Caddy runs in Docker, so these listen on the Docker bridge address instead of loopback.
for s in read-api relayer analytics; do
  sudo tee "/etc/systemd/system/rooq@$s.service.d/bind.conf" >/dev/null <<E
[Service]
Environment=BIND_HOST=172.18.0.1
E
done
# The analytics index must survive restarts and releases, which CacheDirectory doesn't promise.
sudo tee /etc/systemd/system/rooq@analytics.service.d/state.conf >/dev/null <<E
[Service]
StateDirectory=rooq/analytics
Environment=ANALYTICS_DB_PATH=/var/lib/rooq/analytics/analytics.db
E
# The admin's service probes default to loopback; read-api and the relayer only listen on the bridge address above.
sudo tee /etc/systemd/system/rooq@analytics.service.d/health.conf >/dev/null <<E
[Service]
Environment=ANALYTICS_HEALTH_URLS=read-api=http://172.18.0.1:8710,relayer=http://172.18.0.1:8711
E
# Every service here shares one IP against the public testnet RPC, so analytics stays slow enough to never crowd them out.
# A full rebuild should be backfilled elsewhere and its database copied in; this pacing only covers catching up.
sudo tee /etc/systemd/system/rooq@analytics.service.d/pace.conf >/dev/null <<E
[Service]
Environment=ANALYTICS_RPC_CONCURRENCY=1
Environment=ANALYTICS_INDEX_INTERVAL_MS=30000
Environment=ANALYTICS_TICK_BUDGET_MS=5000
Environment=ANALYTICS_LOG_RANGE_BLOCKS=50000
E
# The ROOQ token slice reads Robinhood Chain mainnet, a different RPC host from the testnet services.
sudo tee /etc/systemd/system/rooq@analytics.service.d/token.conf >/dev/null <<E
[Service]
Environment=ROOQ_TOKEN_RPC_URL=https://rpc.mainnet.chain.robinhood.com
E
sudo systemctl daemon-reload
sudo systemctl restart rooq@read-api rooq@relayer rooq@queue rooq@coordinator rooq@risk-a rooq@risk-b rooq@price-relay rooq@analytics

C=/home/ubuntu/blindcount/infra/compose/Caddyfile
sudo cp -p "$C" /home/ubuntu/Caddyfile.before-rooq
if ! grep -q 'api.rooq.trade' "$C"; then
  sudo tee -a "$C" >/dev/null <<E

api.rooq.trade {
	request_body {
		max_size 1MB
	}
	@relayer path /v1/relay/* /v1/jobs/* /v1/relayer
	reverse_proxy @relayer 172.18.0.1:8711
	@analytics path /v1/pv /v1/admin/*
	reverse_proxy @analytics 172.18.0.1:8718
	reverse_proxy 172.18.0.1:8710
}
E
elif ! grep -q '@analytics path' "$C"; then
  # A block added before the analytics service gets its route ahead of the read-api fallthrough. tee rewrites the file in
  # place, because replacing it would swap the inode out from under Caddy's bind mount.
  updated="$(awk '
    /^api\.rooq\.trade [{]/ { inblock = 1 }
    inblock && /^[[:blank:]]*reverse_proxy 172\.18\.0\.1:8710$/ { print "\t@analytics path /v1/pv /v1/admin/*"; print "\treverse_proxy @analytics 172.18.0.1:8718" }
    { print }
    inblock && /^}/ { inblock = 0 }
  ' "$C")"
  printf '%s\n' "$updated" | sudo tee "$C" >/dev/null
  grep -q '@analytics path' "$C" || { echo "could not add the analytics route to $C" >&2; exit 1; }
fi
docker exec compose-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -1
docker exec compose-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -1
sleep 20
systemctl list-units 'rooq@*' --no-legend --plain | awk '{print $1,$3,$4}'
REMOTE

echo "api: $(curl -s -o /dev/null -w '%{http_code}' --max-time 25 https://api.rooq.trade/v1/deployment)"
