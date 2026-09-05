#!/usr/bin/env node
/**
 * Commit a future fixture schedule and record the independently intended state for signing.
 *
 * The values written to .env come from the transaction plan. Post-transaction reads verify
 * that the chain accepted that plan; the worker later performs its own confirmation-safe
 * read and compares it with the separately signed control-plane message.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, defineChain, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENV = path.join(ROOT, '.env');

if (!fs.existsSync(ENV)) throw new Error('.env is absent; run pnpm testnet:init first');
let text = fs.readFileSync(ENV, 'utf8');
const read = (name) => {
  const match = new RegExp(`^${name}=(.*)$`, 'm').exec(text);
  return match?.[1].trim() || undefined;
};
const required = (name) => {
  const value = read(name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
};
const write = (name, value) => {
  const line = `${name}=${value}`;
  text = new RegExp(`^${name}=.*$`, 'm').test(text)
    ? text.replace(new RegExp(`^${name}=.*$`, 'm'), line)
    : `${text.trimEnd()}\n${line}\n`;
};

const rpcUrl = required('XLAYER_TESTNET_RPC_URL');
const asset = getAddress(required('FIXTURE_ASSET_TESTNET_ADDRESS'));
const account = privateKeyToAccount(required('FIXTURE_ADMIN_PRIVATE_KEY'));
const configuredAdmin = getAddress(required('FIXTURE_ADMIN_ADDRESS'));
if (account.address.toLowerCase() !== configuredAdmin.toLowerCase()) {
  throw new Error('FIXTURE_ADMIN_PRIVATE_KEY does not match FIXTURE_ADMIN_ADDRESS');
}

const chain = defineChain({
  id: 1952,
  name: 'X Layer Testnet',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000 }) });
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
if ((await publicClient.getChainId()) !== 1952) throw new Error('RPC is not X Layer testnet');

const abi = [
  {
    type: 'function',
    name: 'getCurrentMultiplier',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'newMultiplierNonce',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'newMultiplierActivationTime',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'scheduleMultiplier',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'uint256' }, { type: 'uint256' }],
    outputs: [],
  },
];

const [block, currentMultiplier, currentNonce] = await Promise.all([
  publicClient.getBlock(),
  publicClient.readContract({ address: asset, abi, functionName: 'getCurrentMultiplier' }),
  publicClient.readContract({ address: asset, abi, functionName: 'newMultiplierNonce' }),
]);
const activation = block.timestamp + 30n * 24n * 60n * 60n;
const intendedNonce = currentNonce + 1n;
const futureMultiplier = currentMultiplier * 2n;

const hash = await walletClient.writeContract({
  address: asset,
  abi,
  functionName: 'scheduleMultiplier',
  args: [futureMultiplier, activation],
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success') throw new Error(`fixture schedule transaction ${hash} failed`);

// Public RPC traffic may be load-balanced across nodes that converge a few seconds after
// the receipt is visible. Poll for the exact planned state instead of accepting one stale
// post-receipt read or broadcasting a blind retry.
let planVisible = false;
for (let attempt = 0; attempt < 20; attempt += 1) {
  const [observedNonce, observedActivation] = await Promise.all([
    publicClient.readContract({ address: asset, abi, functionName: 'newMultiplierNonce' }),
    publicClient.readContract({ address: asset, abi, functionName: 'newMultiplierActivationTime' }),
  ]);
  if (observedNonce === intendedNonce && observedActivation === activation) {
    planVisible = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
if (!planVisible) {
  throw new Error('post-transaction fixture state does not match the committed intent');
}

write('FIXTURE_MULTIPLIER_VALUE', currentMultiplier.toString());
write('FIXTURE_MULTIPLIER_DECIMALS', '18');
write('FIXTURE_MULTIPLIER_NONCE', intendedNonce.toString());
write('FIXTURE_SCHEDULED_ACTIVATION', new Date(Number(activation) * 1_000).toISOString());
fs.writeFileSync(ENV, text, { mode: 0o600 });
fs.chmodSync(ENV, 0o600);

console.log(`fixture intent committed in block ${receipt.blockNumber}`);
console.log(`transaction          ${hash}`);
console.log(`current multiplier   ${currentMultiplier} at 18 decimals`);
console.log(`intended nonce       ${intendedNonce}`);
console.log(`scheduled activation ${new Date(Number(activation) * 1_000).toISOString()}`);
console.log('Signed control-plane values recorded in .env; no secret was printed.');
