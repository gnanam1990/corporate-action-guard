#!/usr/bin/env node
/**
 * Is the testnet deployment ready to run?
 *
 * Reports exactly what is missing and what to do about it. Written because "it didn't
 * work" is a useless failure mode when four separate things must line up: a funded
 * deployer, a reachable RPC, the right chain, and a deployment artifact.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, formatEther, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ARTIFACT = path.join(ROOT, 'contracts/deployments/xlayer-testnet.json');

/** Minimal .env reader. No dependency, and it never echoes a value. */
function readEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

const env = { ...readEnv(), ...process.env };
const rpcUrl = env['XLAYER_TESTNET_RPC_URL'] ?? 'https://testrpc.xlayer.tech';

/** Roughly what deploying five contracts plus two config transactions costs. */
const REQUIRED_WEI = 200_000_000_000_000n; // 0.0002 OKB, generous

const checks = [];
let deployerAddress;

const key = env['TESTNET_DEPLOYER_PRIVATE_KEY'];
if (key === undefined || key === '') {
  checks.push({
    ok: false,
    name: 'deployer key',
    detail: 'TESTNET_DEPLOYER_PRIVATE_KEY is not set in .env',
  });
} else {
  try {
    deployerAddress = privateKeyToAccount(key).address;
    // The address is public and safe to print. The key is not, and never is.
    checks.push({
      ok: true,
      name: 'deployer key',
      detail: `configured, address ${deployerAddress}`,
    });
  } catch {
    checks.push({
      ok: false,
      name: 'deployer key',
      detail: 'set but not a valid 32-byte private key',
    });
  }
}

const signerKey = env['RECEIPT_SIGNER_PRIVATE_KEY'];
checks.push({
  ok: signerKey !== undefined && signerKey !== '',
  name: 'receipt signer key',
  detail:
    signerKey === undefined || signerKey === ''
      ? 'RECEIPT_SIGNER_PRIVATE_KEY is not set'
      : 'configured',
});

if (deployerAddress !== undefined && signerKey !== undefined && signerKey !== '') {
  try {
    const signerAddress = privateKeyToAccount(signerKey).address;
    checks.push({
      // Separate identities, so compromising the deployer does not grant signing.
      ok: signerAddress.toLowerCase() !== deployerAddress.toLowerCase(),
      name: 'signer is a separate identity',
      detail:
        signerAddress.toLowerCase() === deployerAddress.toLowerCase()
          ? 'the deployer and the receipt signer are the SAME key — they must be distinct'
          : 'deployer and signer are distinct',
    });
  } catch {
    checks.push({ ok: false, name: 'receipt signer key', detail: 'not a valid private key' });
  }
}

let balance = 0n;
let chainOk = false;

try {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000 }) });
  const chainId = await client.getChainId();
  chainOk = chainId === 1952;
  checks.push({
    ok: chainOk,
    name: 'testnet RPC',
    detail: chainOk
      ? `${rpcUrl} serves chain 1952`
      : `${rpcUrl} serves chain ${chainId}, expected 1952`,
  });

  if (deployerAddress !== undefined) {
    balance = await client.getBalance({ address: deployerAddress });
    checks.push({
      ok: balance >= REQUIRED_WEI,
      name: 'deployer funded',
      detail: `${formatEther(balance)} OKB (need about ${formatEther(REQUIRED_WEI)})`,
    });
  }
} catch (err) {
  checks.push({
    ok: false,
    name: 'testnet RPC',
    detail: `${rpcUrl} unreachable: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'}`,
  });
}

const deployed = fs.existsSync(ARTIFACT);
checks.push({
  ok: deployed,
  name: 'deployment artifact',
  detail: deployed
    ? path.relative(ROOT, ARTIFACT)
    : 'not deployed yet (this is expected before the first deploy)',
});

for (const check of checks) {
  console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name.padEnd(30)} ${check.detail}`);
}

const blocking = checks.filter((c) => !c.ok && c.name !== 'deployment artifact');

console.log('');
if (blocking.length === 0 && !deployed) {
  console.log('Ready to deploy. Run:  pnpm testnet:deploy');
  process.exit(0);
}
if (blocking.length === 0 && deployed) {
  console.log('Deployed. Run:  pnpm testnet:prove');
  process.exit(0);
}

if (deployerAddress !== undefined && balance < REQUIRED_WEI && chainOk) {
  console.log('Next step: fund the deployer with X Layer testnet OKB.');
  console.log('');
  console.log(`  address: ${deployerAddress}`);
  console.log('  faucet:  https://www.okx.com/xlayer/faucet   (select X Layer Testnet)');
  console.log('');
  console.log('One faucet drip is far more than enough; the deploy costs about 0.00012 OKB.');
} else {
  console.log(`${blocking.length} blocking problem(s) above.`);
}
process.exit(1);
