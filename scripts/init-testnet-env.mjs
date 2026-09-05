#!/usr/bin/env node
/**
 * Initialize throwaway X Layer testnet identities without printing secret material.
 *
 * Existing non-empty values are preserved. The fixture administrator intentionally reuses
 * the deployer identity because DeployTestnet makes the broadcaster the fixture admin; the
 * receipt signer is always a separate identity.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENV = path.join(ROOT, '.env');
const EXAMPLE = path.join(ROOT, '.env.example');

let text = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : fs.readFileSync(EXAMPLE, 'utf8');
const created = !fs.existsSync(ENV);

const read = (name) => {
  const match = new RegExp(`^${name}=(.*)$`, 'm').exec(text);
  return match?.[1].trim() || undefined;
};

const write = (name, value) => {
  const line = `${name}=${value}`;
  text = new RegExp(`^${name}=.*$`, 'm').test(text)
    ? text.replace(new RegExp(`^${name}=.*$`, 'm'), line)
    : `${text.trimEnd()}\n${line}\n`;
};

const deployerKey = read('TESTNET_DEPLOYER_PRIVATE_KEY') ?? generatePrivateKey();
const signerKey = read('RECEIPT_SIGNER_PRIVATE_KEY') ?? generatePrivateKey();
const deployer = privateKeyToAccount(deployerKey);
const signer = privateKeyToAccount(signerKey);

if (deployer.address.toLowerCase() === signer.address.toLowerCase()) {
  throw new Error('The deployer and receipt signer must be separate testnet identities.');
}

write('TESTNET_DEPLOYER_PRIVATE_KEY', deployerKey);
write('RECEIPT_SIGNER_MODE', 'local');
write('RECEIPT_SIGNER_PRIVATE_KEY', signerKey);
write('RECEIPT_SIGNER_ADDRESS', signer.address);
write('FIXTURE_ADMIN_PRIVATE_KEY', deployerKey);
write('FIXTURE_ADMIN_ADDRESS', deployer.address);
write('XLAYER_TESTNET_RPC_URL', read('XLAYER_TESTNET_RPC_URL') ?? 'https://testrpc.xlayer.tech');

function ensureApiKeyPair(rawName, hashName, keyId) {
  const raw = read(rawName);
  const hash = read(hashName);
  if ((raw === undefined) !== (hash === undefined)) {
    throw new Error(`${rawName} and ${hashName} must either both be set or both be absent.`);
  }

  const valid = raw === undefined || new RegExp(`^cag_${keyId}_[A-Za-z0-9]{32,}$`).test(raw);
  if (raw !== undefined && hash !== undefined && valid) {
    const actualHash = createHash('sha256').update(raw, 'utf8').digest('hex');
    if (actualHash !== hash.toLowerCase()) {
      throw new Error(`${rawName} does not match ${hashName}.`);
    }
    return;
  }

  // Hex is intentionally used rather than base64url: the API-key parser accepts only
  // alphanumeric secret material, so '-' and '_' would make a generated key unusable.
  const generated = `cag_${keyId}_${randomBytes(24).toString('hex')}`;
  write(rawName, generated);
  write(hashName, createHash('sha256').update(generated, 'utf8').digest('hex'));
}

ensureApiKeyPair('FIXTURE_API_KEY', 'FIXTURE_API_KEY_HASH', 'fixadm01');
ensureApiKeyPair('INTEGRATOR_API_KEY', 'INTEGRATOR_API_KEY_HASH', 'integ001');

fs.writeFileSync(ENV, text, { mode: 0o600 });
fs.chmodSync(ENV, 0o600);

console.log(`${created ? 'Created' : 'Updated'} .env with mode 600; no secret was printed.`);
console.log(`deployer address       ${deployer.address}`);
console.log(`receipt signer address ${signer.address}`);
console.log('fixture API key pair   configured locally');
console.log('integrator API key pair configured locally');
