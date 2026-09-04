#!/usr/bin/env node
/**
 * Copy verified deployment addresses from the artifact into .env.
 *
 * Only ever reads the artifact the deploy script wrote, which it writes only after
 * post-broadcast bytecode verification. Addresses are never hand-entered: a typo in a
 * contract address is a silent, total failure.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ARTIFACT = path.join(ROOT, 'contracts/deployments/xlayer-testnet.json');
const ENV = path.join(ROOT, '.env');

if (!fs.existsSync(ARTIFACT)) {
  console.error('No deployment artifact. The deploy did not complete verification.');
  process.exit(1);
}

const artifact = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
if (artifact.chainId !== 1952) {
  console.error(`Artifact claims chain ${artifact.chainId}, refusing to record anything but 1952.`);
  process.exit(1);
}
if (artifact.implementationVersion !== 2) {
  console.error('Artifact is for an obsolete guard implementation; redeploy before recording it.');
  process.exit(1);
}

const mapping = {
  GUARD_ADAPTER_TESTNET_ADDRESS: artifact.actionGuardAdapter,
  GUARD_ADAPTER_DEPLOYED_AT_BLOCK: String(artifact.deployedAtBlock),
  PROTECTED_VAULT_TESTNET_ADDRESS: artifact.protectedVault,
  FIXTURE_ASSET_TESTNET_ADDRESS: artifact.fixtureAsset,
  FIXTURE_WRAPPER_TESTNET_ADDRESS: artifact.fixtureWrapper,
};

let env = fs.readFileSync(ENV, 'utf8');
for (const [name, value] of Object.entries(mapping)) {
  if (typeof value !== 'string') continue;
  env = new RegExp(`^${name}=.*$`, 'm').test(env)
    ? env.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=${value}`)
    : `${env.trimEnd()}\n${name}=${value}\n`;
  console.log(`  ${name} = ${value}`);
}
fs.writeFileSync(ENV, env, { mode: 0o600 });
console.log(
  `\nRecorded from ${path.relative(ROOT, ARTIFACT)} (block ${artifact.deployedAtBlock}).`,
);
