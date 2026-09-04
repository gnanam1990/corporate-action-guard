#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fixtureEvidenceMessage } from '../packages/domain/dist/index.js';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = path.resolve(import.meta.dirname, '..');

function readEnvFile() {
  const filename = path.join(root, '.env');
  if (!fs.existsSync(filename)) return {};
  const result = {};
  for (const line of fs.readFileSync(filename, 'utf8').split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match !== null) result[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return result;
}

const env = { ...readEnvFile(), ...process.env };
const required = (name) => {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
};
const decimal = (name, { positive = false } = {}) => {
  const value = required(name);
  if (!/^[0-9]+$/.test(value) || (positive && BigInt(value) === 0n)) {
    throw new Error(`${name} must be ${positive ? 'a positive' : 'an unsigned'} integer`);
  }
  return value;
};

const adminKey = required('FIXTURE_ADMIN_PRIVATE_KEY');
const account = privateKeyToAccount(adminKey);
const configuredAdmin = getAddress(required('FIXTURE_ADMIN_ADDRESS'));
if (account.address.toLowerCase() !== configuredAdmin.toLowerCase()) {
  throw new Error('FIXTURE_ADMIN_PRIVATE_KEY does not match FIXTURE_ADMIN_ADDRESS');
}

const scheduledInput = env['FIXTURE_SCHEDULED_ACTIVATION'] ?? 'none';
const scheduledActivation =
  scheduledInput === 'none' ? null : new Date(scheduledInput).toISOString();
const payload = {
  assetId: env['FIXTURE_ASSET_ID'] ?? 'CAG-FIXTURE',
  chainId: 1952,
  tokenAddress: getAddress(required('FIXTURE_ASSET_TESTNET_ADDRESS')),
  wrapperAddress: getAddress(required('FIXTURE_WRAPPER_TESTNET_ADDRESS')),
  multiplierValue: decimal('FIXTURE_MULTIPLIER_VALUE', { positive: true }),
  multiplierDecimals: Number(decimal('FIXTURE_MULTIPLIER_DECIMALS')),
  multiplierNonce: decimal('FIXTURE_MULTIPLIER_NONCE'),
  scheduledActivation,
  observedAt: new Date().toISOString(),
};
if (!Number.isSafeInteger(payload.multiplierDecimals) || payload.multiplierDecimals > 36) {
  throw new Error('FIXTURE_MULTIPLIER_DECIMALS must be an integer from 0 through 36');
}

const signature = await account.signMessage({ message: fixtureEvidenceMessage(payload) });
const endpoint = new URL('/v1/testnet/fixture-evidence', required('API_PUBLIC_BASE_URL'));
const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': required('FIXTURE_API_KEY'),
  },
  body: JSON.stringify({ ...payload, signature }),
  signal: AbortSignal.timeout(10_000),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  throw new Error(`fixture evidence API returned ${response.status}: ${JSON.stringify(body)}`);
}
process.stdout.write(
  `fixture intent accepted for ${payload.assetId} at ${payload.observedAt}; event ${body.eventId}\n`,
);
