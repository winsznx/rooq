# Running the private services on a VPS

Rooq's backend on a Linux server with systemd. Each service is one `rooq@<name>` unit: its own process, its own throwaway user, its own root-only secrets file. This covers testnet only. It assumes the contracts are already deployed (`scripts/deploy-private-testnet.sh --broadcast`) and `contracts/deployments/privacy-46630.json` is the real deployment file, not a simulation output.

We use systemd rather than docker compose. systemd runs on any Debian or Ubuntu VPS with no daemon to add, reads the env files as root and hands each service only its own secrets, restarts failed services, and keeps logs in journald with rotation. Running one service on a second host is one enabled unit. Compose would add a container daemon and an image pipeline for no isolation we don't already get from per-unit users and sandboxing.

## What's public and what isn't

| Port | Service | Exposure |
| --- | --- | --- |
| 443, 80 | Caddy (HTTPS, ACME challenge) | Public |
| 22 | SSH | Public or your admin network |
| 8710 | read-api | Loopback only, public through Caddy |
| 8711 | relayer | Loopback only, public through Caddy |
| 8712 | queue | Loopback only |
| 8713 | coordinator | Loopback only |
| 8714, 8715 | risk-a, risk-b | Loopback only |
| 8716 | maker | Loopback only |
| 8717 | price-relay | Loopback only |

`BIND_HOST` is fixed to 127.0.0.1 in the unit file. Don't open 8710 to 8717 in a firewall.

The relayer and read API see client IPs for rate limiting only, for at most 60 seconds, in memory. Caddy's access log is off by default and the config doesn't turn it on. Don't add a `log` directive: a saved IP next to a request would undo that.

## Web app settings (Vercel)

- `NEXT_PUBLIC_PRIVATE_READ_URL=https://<read host>` and `NEXT_PUBLIC_PRIVATE_RELAYER_URL=https://<relayer host>`. `apps/web/lib/csp.ts` builds `connect-src` from these, so no separate CSP edit is needed.
- `NEXT_PUBLIC_PRIVATE_RPC_URL` if you use an RPC other than the public testnet one.
- `NEXT_PUBLIC_PRIVATE_MARKET_MAP` and `NEXT_PUBLIC_PRIVATE_POOL_MAP`, exactly as the deploy script printed them. Normal value for both: `TSLA:1,AMZN:2,PLTR:3,NFLX:4,AMD:5`.
- On the VPS, `ROOQ_ALLOWED_ORIGINS` in `/etc/rooq/common.env` must list each origin of the web app, comma separated, exact match with no wildcards (`https://rooq.example,https://www.rooq.example`). Add a Vercel preview URL only while you test on it.

## First install

Needs a Debian or Ubuntu server with systemd and outbound HTTPS (testnet RPC, `api.robinhood.com`, `nodejs.org`, GitHub, the npm registry and the prover's CRS download). Have `curl`, `unzip` and `xz-utils` installed. We tested on an arm64 container, not a real VPS, so 8 GB of RAM is a starting guess: at idle each service used 50 to 140 MB, but proof memory on a small box hasn't been measured. Watch `journalctl` for OOM kills on the first day.

1. On your own machine, after the real deployment: `infra/vps/make-release.sh`. It prints the tarball path. Nothing in it is secret; keys stay out of it. Copy it to the server.
2. On the server, as root: unpack it once and run the installer from inside.
   ```bash
   tar -xzf rooq-private-*.tar.gz && bash rooq-private-*/infra/vps/install-release.sh rooq-private-*.tar.gz
   ```
   This installs pinned Node, pnpm and Bun under `/opt/rooq/tools`, unpacks the release under `/opt/rooq/releases`, points `/opt/rooq/current` at it, installs the `rooq@.service` unit and writes blank env files to `/etc/rooq` (mode 0600, owned by root). It starts nothing.
3. Fill the env files. Each line has a comment naming the Keychain item that holds the value on the founder's Mac. Move values without writing them anywhere else. From the Mac, one variable at a time:
   ```bash
   put() { printf '%s=%s\n' "$2" "$(security find-generic-password -s "$3" -w)" | ssh root@VPS "cat >>/etc/rooq/$1.env"; }
   put risk-b RISK_SK rooq-private-risk-b
   ```
   A later line wins over an earlier blank one, so the template lines can stay. `common.env` holds `RPC_URL` and `ROOQ_ALLOWED_ORIGINS`.
4. Install Caddy (`apt install caddy`, or Caddy's own package for a recent version), copy `infra/vps/Caddyfile` to `/etc/caddy/Caddyfile`, and write `/etc/rooq/caddy.env`:
   ```bash
   ROOQ_ACME_EMAIL=you@example.com
   ROOQ_READ_HOST=read.example.com
   ROOQ_RELAYER_HOST=relayer.example.com
   ```
   Then add a drop-in so Caddy loads it, and point DNS A records for both hosts at the server:
   ```bash
   install -d /etc/systemd/system/caddy.service.d
   printf '[Service]\nEnvironmentFile=/etc/rooq/caddy.env\n' >/etc/systemd/system/caddy.service.d/rooq.conf
   systemctl daemon-reload && systemctl restart caddy
   ```
5. Open only 22, 80 and 443 in the firewall (`ufw allow 22,80,443/tcp`, or your provider's panel).
6. Start: use the exact `systemctl start` line the installer printed, then check health:
   ```bash
   rooq-health
   ```
   It lists each unit, its `/health`, and for the relay each feed's age. Exit code 0 means all good.
7. Start the maker once you have `MAKER_TERMS` and a funded shielded wallet (Keychain `rooq-private-maker-seed`): fill `/etc/rooq/maker.env`, then `systemctl enable --now rooq@maker`.

Fund the gas addresses before starting. The addresses are printed by `cast wallet address` for each gas key; the relay key needs the most (about 0.005 ETH a day at 0.01 gwei if prices move constantly, far less outside US market hours).

## Updates

Build a new tarball the same way and run the installer again on each host:

```bash
bash rooq-private-*/infra/vps/install-release.sh rooq-private-*.tar.gz
rooq-health
```

The installer leaves `/etc/rooq` alone and restarts running units onto the new release. A restart takes a few seconds and interrupts nothing that can't be replayed; services rebuild their state from chain. To go back, point the symlink at the previous release and restart:

```bash
ln -sfn /opt/rooq/releases/<previous> /opt/rooq/current && systemctl restart 'rooq@*'
```

Logs are in journald: `journalctl -u rooq@risk-a -f`. Services only log reasons, counts and public hashes, and drop any field named like a key, seed or address.

## Run one risk worker on a second host

LIQ-04 needs the two risk workers on separate hosts. Move risk-a:

1. On the second host, same release, only its unit:
   ```bash
   ROOQ_ONLY=risk-a bash rooq-private-*/infra/vps/install-release.sh rooq-private-*.tar.gz
   ```
2. Fill only `common.env` and `risk-a.env` on that host. It needs outbound HTTPS only; no ports are exposed and no Caddy is needed.
3. Start it: `systemctl start rooq@risk-a`, then `rooq-health`.
4. On the first host, stop it for good and take its key off that machine:
   ```bash
   systemctl disable --now rooq@risk-a && shred -u /etc/rooq/risk-a.env
   ```
5. The read API asks workers for spot quotes on loopback by default. Tell it where they are now, in `/etc/rooq/read-api.env`, then restart it: `SPOT_QUOTE_URLS=http://127.0.0.1:8713,http://127.0.0.1:8715`. Leaving risk-a out loses one of the three quote sources but nothing else. Only add a second host's worker to that list through a private network, never by opening 8714 to the internet.

Keep the second host on the opposite side of whatever you think can fail: different provider or at least a different region.

## Key rotation

Follow `KEY_INCIDENTS.md`. On this launcher, step 2 means editing the worker or coordinator env file: set `RISK_SK` (or `COORDINATOR_SK`) to the new key and put the old one in `RISK_SK_PREVIOUS` (or `COORDINATOR_SK_PREVIOUS`, comma separated if more than one), then `systemctl restart rooq@<name>`. `rooq-health` and each service's `/health` show `keys.keysHeld` and `keys.currentKeyHeld`.

## Oracle operations

`price-relay` is a single-operator TEST relay of `api.robinhood.com/rhj/prices`. It isn't an independent oracle, and the app labels it that way. It writes nothing when the source is halted, unreachable or older than 120 seconds, so feeds age out instead of carrying a wrong price.

The feed heartbeat on this deployment is 7 days, so a stopped relay leaves an old price usable for up to a week. Watch `rooq-health` for feed ages and alert on any feed older than an hour during market hours. Other facts are in `infra/runbooks/RECOVERY.md`.

Don't put the deployer key on this server. The relay has its own key and the deployer handed each feed to it at deploy time.
