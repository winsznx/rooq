#!/usr/bin/env bash
# Builds the release tarball for a VPS: service source, compiled contract ABIs and circuits, and the deployment file. No
# keys or env files go in it. Run from any machine with `forge build` and `zk/circuits/build.sh` already done.
#
#   infra/vps/make-release.sh [output.tar.gz]
#   ROOQ_DEPLOYMENT_FILE=path infra/vps/make-release.sh    use a deployment file other than contracts/deployments/privacy-46630.json
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$ROOT/dist/rooq-private-$(date -u +%Y%m%dT%H%M%SZ).tar.gz}"
DEPLOYMENT="${ROOQ_DEPLOYMENT_FILE:-$ROOT/contracts/deployments/privacy-46630.json}"
ARTIFACTS=(PrivatePairs PrivateSpot PrivateMarkets OracleAdapter AppendVerifier SpendVerifier LockVerifier OpenPairVerifier LiquidateVerifier ReleaseVerifier FundingEpochVerifier ClosePairVerifier ExitRequestVerifier PairUpdateVerifier RedeemClaimVerifier InsuranceSweepVerifier)

python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if int(d["chainId"]) == 46630 and d.get("marketMap") else "deployment file is not a 46630 private deployment with five markets")' "$DEPLOYMENT"
for a in "${ARTIFACTS[@]}"; do
  [ -f "$ROOT/contracts/out/$a.sol/$a.json" ] || { echo "missing contracts/out/$a.sol/$a.json; run forge build"; exit 1; }
done
[ -f "$ROOT/zk/circuits/target/lock.json" ] || { echo "missing zk/circuits/target; run zk/circuits/build.sh"; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
NAME="$(basename "$OUT" .tar.gz)"
DEST="$STAGE/$NAME"
mkdir -p "$DEST/contracts/deployments" "$DEST/zk/circuits/target" "$DEST/apps" "$DEST/packages" "$DEST/infra"
for f in package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json; do cp "$ROOT/$f" "$DEST/"; done
for a in "${ARTIFACTS[@]}"; do
  mkdir -p "$DEST/contracts/out/$a.sol"
  cp "$ROOT/contracts/out/$a.sol/$a.json" "$DEST/contracts/out/$a.sol/"
done
cp "$DEPLOYMENT" "$DEST/contracts/deployments/privacy-46630.json"
cp "$ROOT"/zk/circuits/target/*.json "$DEST/zk/circuits/target/"
for d in apps/private-services packages/config packages/private-sdk infra/vps; do
  rsync -a --exclude node_modules --exclude dist --exclude .turbo "$ROOT/$d/" "$DEST/$d/"
done
mkdir -p "$(dirname "$OUT")"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$STAGE" -czf "$OUT" "$NAME"
echo "$OUT"
