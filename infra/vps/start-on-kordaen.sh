#!/usr/bin/env bash
# Run on the founder's Mac after install-release.sh. Copies each service's keys from the macOS Keychain into its own
# root-only env file on kordaen, caps the stack's CPU and memory, starts it, and routes api.rooq.trade through the
# shared Caddy. Key values travel over stdin on SSH and are never printed or stored anywhere else.
#
# Safe to run twice: env files are only filled if empty, and the Caddy block is only added once.
set -euo pipefail

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
put queue QUEUE_TX_KEY rooq-private-gas-queue
put coordinator COORDINATOR_SK rooq-private-coordinator
put coordinator COORDINATOR_TX_KEY rooq-private-gas-coordinator
for w in a b; do
  put "risk-$w" RISK_SK "rooq-private-risk-$w"
  put "risk-$w" RISK_TX_KEY "rooq-private-gas-risk-$w"
  put "risk-$w" RISK_REWARD_SEED "rooq-private-reward-$w"
done
put maker MAKER_SEED rooq-private-maker-seed
put price-relay PRICE_RELAY_TX_KEY rooq-private-gas-price-relay

ssh kordaen 'bash -s' <<'REMOTE'
set -euo pipefail
sudo tee /etc/systemd/system/rooq.slice >/dev/null <<E
[Unit]
Description=Rooq private services, capped so proving leaves room for the other projects on this host
[Slice]
CPUQuota=400%
MemoryMax=5G
E
sudo install -d /etc/systemd/system/rooq@.service.d /etc/systemd/system/rooq@read-api.service.d /etc/systemd/system/rooq@relayer.service.d
sudo tee /etc/systemd/system/rooq@.service.d/limits.conf >/dev/null <<E
[Service]
Slice=rooq.slice
CPUQuota=200%
MemoryMax=2G
E
# The shared Caddy runs in Docker, so these two listen on the Docker bridge address instead of loopback.
for s in read-api relayer; do
  sudo tee "/etc/systemd/system/rooq@$s.service.d/bind.conf" >/dev/null <<E
[Service]
Environment=BIND_HOST=172.18.0.1
E
done
sudo systemctl daemon-reload
sudo systemctl restart rooq@read-api rooq@relayer rooq@queue rooq@coordinator rooq@risk-a rooq@risk-b rooq@price-relay

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
	reverse_proxy 172.18.0.1:8710
}
E
fi
docker exec compose-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -1
docker exec compose-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -1
sleep 20
systemctl list-units 'rooq@*' --no-legend --plain | awk '{print $1,$3,$4}'
REMOTE

echo "api: $(curl -s -o /dev/null -w '%{http_code}' --max-time 25 https://api.rooq.trade/v1/deployment)"
