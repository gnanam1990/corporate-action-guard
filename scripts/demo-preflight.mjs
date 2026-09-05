#!/usr/bin/env node
/**
 * Prove the complete local-control-plane -> signed receipt -> X Layer testnet path.
 *
 * Secret material is read from the ignored .env file and is never printed or written to
 * the evidence artifact. This script refuses every chain except X Layer testnet (1952).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildGuardTransaction, GuardClient } from '../packages/sdk/dist/index.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENV = path.join(ROOT, '.env');
const DEPLOYMENT = path.join(ROOT, 'contracts/deployments/xlayer-testnet.json');
const OUT = path.join(ROOT, 'docs/evidence/end-to-end-preflight.md');

function readEnv() {
  if (!fs.existsSync(ENV)) throw new Error('Missing .env. Run: pnpm testnet:init');
  const out = {};
  for (const line of fs.readFileSync(ENV, 'utf8').split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

const env = { ...readEnv(), ...process.env };
const required = (name) => {
  const value = env[name];
  if (typeof value !== 'string' || value === '') throw new Error(`${name} is required`);
  return value;
};

const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT, 'utf8'));
if (deployment.chainId !== 1952 || deployment.implementationVersion !== 2) {
  throw new Error('Refusing an obsolete or non-testnet deployment artifact.');
}

const chain = {
  id: 1952,
  name: 'X Layer Testnet',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: {
    default: { http: [env.XLAYER_TESTNET_RPC_URL ?? 'https://testrpc.xlayer.tech'] },
  },
};
const publicClient = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
const caller = privateKeyToAccount(required('TESTNET_DEPLOYER_PRIVATE_KEY'));
const wallet = createWalletClient({
  account: caller,
  chain,
  transport: http(chain.rpcUrls.default.http[0]),
});

const erc20Abi = [
  {
    type: 'function',
    name: 'newMultiplierNonce',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'faucet',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
];

async function waitForSuccess(hash, label) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  return receipt;
}

async function main() {
  const chainId = await publicClient.getChainId();
  if (chainId !== 1952) throw new Error(`refusing chain ${chainId}; expected 1952`);

  const asset = getAddress(deployment.fixtureAsset);
  const adapter = getAddress(deployment.actionGuardAdapter);
  const amount = 10n ** 18n;
  const balance = await publicClient.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [caller.address],
  });
  if (balance < amount) {
    const hash = await wallet.writeContract({
      address: asset,
      abi: erc20Abi,
      functionName: 'faucet',
      args: [100n * amount],
    });
    await waitForSuccess(hash, 'fixture funding');
  }

  const allowance = await publicClient.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [caller.address, deployment.protectedVault],
  });
  if (allowance < amount) {
    const hash = await wallet.writeContract({
      address: asset,
      abi: erc20Abi,
      functionName: 'approve',
      args: [deployment.protectedVault, 2n ** 256n - 1n],
    });
    await waitForSuccess(hash, 'vault approval');
  }

  const nonce = await publicClient.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'newMultiplierNonce',
  });
  const operation = {
    chainId,
    assetId: 'CAG-FIXTURE',
    target: getAddress(deployment.protectedVault),
    asset,
    wrapper: getAddress(deployment.fixtureWrapper),
    actionType: 'DEPOSIT',
    caller: caller.address,
    recipient: caller.address,
    amount,
    expectedMultiplierNonce: nonce,
  };

  const api = new GuardClient({
    baseUrl: env.API_BASE_URL ?? 'http://localhost:4000',
    apiKey: required('INTEGRATOR_API_KEY'),
    timeoutMs: 20_000,
    maxRetries: 0,
  });
  const decision = await api.preflight(operation, {
    idempotencyKey: `xlayer-demo-${Date.now()}-${caller.address.toLowerCase()}`,
  });
  if (decision.decision !== 'ALLOW') {
    throw new Error(`preflight BLOCK: ${decision.reasonCodes.join(', ')}`);
  }
  if (getAddress(decision.receipt.verifyingContract) !== adapter) {
    throw new Error('API receipt references a different adapter than the deployment artifact.');
  }

  const transaction = buildGuardTransaction(decision.receipt);
  const txHash = await wallet.sendTransaction({
    account: caller,
    chain,
    to: getAddress(transaction.to),
    data: transaction.data,
    value: transaction.value,
  });
  const transactionReceipt = await waitForSuccess(txHash, 'guarded deposit');
  const provenAt = new Date().toISOString();

  const evidence = `# End-to-end signed preflight proof

Generated by \`pnpm demo:testnet\`. This is public testnet evidence; no private key, API key,
or receipt signature is recorded here.

| Field | Evidence |
|---|---|
| Proven at | ${provenAt} |
| Chain | X Layer testnet (${chainId}) |
| Deployment version | ${deployment.implementationVersion} |
| API decision | ${decision.decision} |
| API request id | \`${decision.requestId}\` |
| Receipt id | \`${decision.receipt.receiptId}\` |
| Operation digest | \`${decision.operationDigest}\` |
| Evidence block | ${decision.evidence.blockNumber ?? 'not reported'} |
| Adapter | \`${adapter}\` |
| Protected target | \`${operation.target}\` |
| Asset / wrapper | \`${operation.asset}\` / \`${operation.wrapper}\` |
| Multiplier nonce | ${nonce} |
| Action | DEPOSIT ${amount} base units |
| Transaction | \`${txHash}\` |
| Mined block | ${transactionReceipt.blockNumber} |
| Receipt status | success |

## What this proves

The running API authenticated an integrator request, evaluated fresh two-source evidence,
issued an EIP-712 receipt from the configured signer, the SDK encoded that receipt, and the
version-2 adapter accepted it once on X Layer testnet before the protected vault executed the
deposit. This does not prove production key custody, mainnet deployment, or an external audit.
`;
  fs.writeFileSync(OUT, evidence);

  console.log('PASS — signed API preflight executed once on X Layer testnet');
  console.log(`request ${decision.requestId}`);
  console.log(`tx      ${txHash}`);
  console.log(`block   ${transactionReceipt.blockNumber}`);
  console.log(`evidence ${path.relative(ROOT, OUT)}`);
}

await main();
