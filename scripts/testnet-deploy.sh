#!/usr/bin/env bash
#
# Deploy the fixture, adapter, and vault to X Layer testnet.
#
# Refuses to run unless every precondition holds. The deploy script itself also refuses any
# chain but 1952 and verifies bytecode after broadcast — this wrapper just fails earlier and
# more legibly.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== preflight =="
node scripts/testnet-status.mjs || {
  echo ""
  echo "Refusing to deploy: fix the failures above first."
  exit 1
}

set -a
# shellcheck disable=SC1091
source .env
set +a

echo ""
echo "== deploying to X Layer testnet (chain 1952) =="
cd contracts
forge script script/DeployTestnet.s.sol:DeployTestnet \
  --rpc-url "$XLAYER_TESTNET_RPC_URL" \
  --broadcast \
  --slow \
  -vv

cd ..
echo ""
echo "== recording the deployed addresses in .env =="
node scripts/record-deployment.mjs

echo ""
echo "Deployed. Next:  pnpm testnet:prove"
