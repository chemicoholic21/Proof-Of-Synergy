#!/usr/bin/env bash
# One-command deploy + pre-seed for ProofOfSynergy contracts on Monad testnet.
# Prereq: fund the DEPLOYER address (see .env) from https://faucet.monad.xyz
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.foundry/bin:$PATH"
set -a; source .env; set +a

echo "Deployer: $(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")"
echo "Balance:  $(cast balance "$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")" --rpc-url "$MONAD_RPC_URL")"

forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$MONAD_RPC_URL" \
  --broadcast \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  -vvv

echo ""
echo ">>> Copy the printed addresses into ../.env.local (NEXT_PUBLIC_*_ADDRESS)."
