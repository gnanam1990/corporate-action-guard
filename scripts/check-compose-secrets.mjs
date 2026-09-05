#!/usr/bin/env node
/**
 * The web container must never be able to see a server secret.
 *
 * Asserted mechanically against the compose file, because "we were careful" is not a
 * control. If someone adds DATABASE_URL to the web service to fix a build, this fails.
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(import.meta.dirname, '../infra/docker-compose.full.yml');
const text = fs.readFileSync(FILE, 'utf8');

/** Names that must not appear anywhere inside the `web:` service block. */
const FORBIDDEN_IN_WEB = [
  'DATABASE_URL',
  'RECEIPT_SIGNER_PRIVATE_KEY',
  'RECEIPT_SIGNER_ADDRESS',
  'AWS_KMS_KEY_ID',
  'AWS_REGION',
  'OPERATOR_API_KEY_HASH',
  'INTEGRATOR_API_KEY_HASH',
  'FIXTURE_API_KEY_HASH',
  'FIXTURE_ADMIN_PRIVATE_KEY',
  'FIXTURE_API_KEY',
  'DEV_API_KEYS',
  'XLAYER_MAINNET_RPC_URL',
  'XLAYER_TESTNET_RPC_URL',
];

/** Extract the `web:` service block by indentation. */
const lines = text.split('\n');
const start = lines.findIndex((l) => /^ {2}web:\s*$/.test(l));
if (start === -1) {
  console.error('No web service found in the compose file.');
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  // A line at two-space indent (a sibling service) or at zero indent ends the block.
  if (/^ {2}\S/.test(lines[i]) || /^\S/.test(lines[i])) {
    end = i;
    break;
  }
}
const webBlock = lines.slice(start, end).join('\n');

const found = FORBIDDEN_IN_WEB.filter((name) => webBlock.includes(name));

if (found.length > 0) {
  console.error('Server secrets are reachable from the web container:\n');
  for (const name of found) console.error(`  - ${name} appears in the web service block`);
  console.error('\nThe console speaks HTTP to the API. It needs no server credential.');
  process.exit(1);
}

// Positive routing assertions prevent a future compose edit from sending SSR traffic back
// to localhost inside the web container while retaining the browser-reachable URL.
if (!/^ {6}API_INTERNAL_BASE_URL: http:\/\/api:4000$/m.test(webBlock)) {
  console.error('The web service must route server-rendered API calls to http://api:4000.');
  process.exit(1);
}
if (!/^ {6}NEXT_PUBLIC_API_BASE_URL: http:\/\/localhost:4000$/m.test(webBlock)) {
  console.error('The web service must expose http://localhost:4000 to browser-side calls.');
  process.exit(1);
}

console.log(
  `Compose secret boundary: OK (0 of ${FORBIDDEN_IN_WEB.length} forbidden names in the web service).`,
);
