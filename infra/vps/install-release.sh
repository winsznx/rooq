#!/usr/bin/env bash
# First install and every update, run as root on the VPS. Installs pinned Node, pnpm and Bun under /opt/rooq/tools,
# unpacks the release, points /opt/rooq/current at it and installs the systemd unit. Env files are created blank and
# never touched again. On an update, running services restart on the new release.
#
#   infra/vps/install-release.sh release.tar.gz                  all services except the maker
#   ROOQ_ONLY=risk-a infra/vps/install-release.sh release.tar.gz    one service on a second host
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
[ "$(uname -s)" = Linux ] || { echo "Linux only; macOS uses apps/private-services/scripts/start-testnet.sh"; exit 1; }
SELF="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=services.sh
source "$SELF/services.sh"
TGZ="${1:?usage: install-release.sh release.tar.gz}"
NODE_VERSION=24.19.0
PNPM_VERSION=12.16.1
BUN_VERSION=1.4.2
TOOLS="$ROOQ_PREFIX/tools"
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64; BUN_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64; BUN_ARCH=aarch64 ;;
  *) echo "unsupported architecture $(uname -m)"; exit 1 ;;
esac

install_tools() {
  mkdir -p "$TOOLS/bin"
  local tmp
  tmp="$(mktemp -d)"
  if [ "$("$TOOLS/node/bin/node" -v 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
    echo "installing node $NODE_VERSION"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz" -o "$tmp/node.tar.xz"
    rm -rf "$TOOLS/node"
    mkdir -p "$TOOLS/node"
    tar -xJf "$tmp/node.tar.xz" -C "$TOOLS/node" --strip-components=1
  fi
  ln -sfn "$TOOLS/node/bin/node" "$TOOLS/bin/node"
  if [ "$("$TOOLS/bin/pnpm" -v 2>/dev/null || true)" != "$PNPM_VERSION" ]; then
    echo "installing pnpm $PNPM_VERSION"
    PATH="$TOOLS/node/bin:$PATH" "$TOOLS/node/bin/npm" install --global --prefix "$TOOLS/pnpm" "pnpm@$PNPM_VERSION"
    ln -sfn "$TOOLS/pnpm/bin/pnpm" "$TOOLS/bin/pnpm"
  fi
  if [ "$("$TOOLS/bin/bun" --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
    echo "installing bun $BUN_VERSION"
    curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-$BUN_ARCH.zip" -o "$tmp/bun.zip"
    (cd "$tmp" && unzip -q bun.zip)
    install -m 755 "$tmp/bun-linux-$BUN_ARCH/bun" "$TOOLS/bin/bun"
  fi
  rm -rf "$tmp"
}

install_release() {
  local name dest
  name="$(tar -tzf "$TGZ" | sed -n '1s#/.*##p')"
  dest="$ROOQ_PREFIX/releases/$name"
  mkdir -p "$ROOQ_PREFIX/releases"
  rm -rf "$dest"
  tar -xzf "$TGZ" -C "$ROOQ_PREFIX/releases"
  chown -R root:root "$dest"
  chmod -R go-w "$dest"
  (cd "$dest" && PATH="$TOOLS/bin:$PATH" pnpm install --frozen-lockfile --prod --filter "@rooq/private-services...")
  chmod -R go+rX "$dest"
  ln -sfn "$dest" "$ROOQ_PREFIX/current"
  echo "$dest"
}

wanted_services() {
  if [ -n "${ROOQ_ONLY:-}" ]; then
    for s in "${ROOQ_SERVICES[@]}"; do [ "$s" = "$ROOQ_ONLY" ] && { echo "$s"; return; }; done
    echo "unknown ROOQ_ONLY=$ROOQ_ONLY; one of: ${ROOQ_SERVICES[*]}" >&2
    return 1
  fi
  printf '%s\n' "${ROOQ_DEFAULT_SERVICES[@]}"
}

command -v curl >/dev/null && command -v unzip >/dev/null && command -v xz >/dev/null || { echo "install curl, unzip and xz-utils first"; exit 1; }
SERVICES="$(wanted_services)"
install_tools
install_release
install -m 644 "$ROOQ_PREFIX/current/infra/vps/systemd/rooq@.service" /etc/systemd/system/rooq@.service
install -d -m 700 "$ROOQ_ETC"
"$ROOQ_PREFIX/current/infra/vps/gen-env-templates.sh" "$ROOQ_ETC"
ln -sfn "$ROOQ_PREFIX/current/infra/vps/healthcheck.sh" /usr/local/bin/rooq-health
systemctl daemon-reload
for s in $SERVICES; do systemctl enable "rooq@$s" >/dev/null; done
systemctl --no-block try-restart 'rooq@*'
echo "installed. Enabled: $(echo "$SERVICES" | tr '\n' ' ')"
UNITS="$(for s in $SERVICES; do printf 'rooq@%s ' "$s"; done)"
echo "Fill $ROOQ_ETC/*.env, then run: systemctl start $UNITS"
echo "Check with: rooq-health"
