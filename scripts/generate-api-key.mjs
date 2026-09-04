#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';

const profiles = {
  integrator: { keyId: 'integ001', envName: 'INTEGRATOR_API_KEY_HASH' },
  operator: { keyId: 'operator', envName: 'OPERATOR_API_KEY_HASH' },
  fixture: { keyId: 'fixadm01', envName: 'FIXTURE_API_KEY_HASH' },
};
const profileName = process.argv[2];
const profile = profiles[profileName];
if (profile === undefined) {
  throw new Error('usage: node scripts/generate-api-key.mjs integrator|operator|fixture');
}

const raw = `cag_${profile.keyId}_${randomBytes(24).toString('base64url')}`;
const hash = createHash('sha256').update(raw, 'utf8').digest('hex');
process.stdout.write(
  [
    'Store the raw key in the client secret manager; it will not be shown again:',
    raw,
    '',
    'Store only this hash in the API environment:',
    `${profile.envName}=${hash}`,
    '',
  ].join('\n'),
);
