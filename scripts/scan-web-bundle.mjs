#!/usr/bin/env node
/**
 * Fails if a server secret NAME or a canary secret VALUE reaches the browser bundle.
 *
 * Next.js inlines anything prefixed NEXT_PUBLIC_ into client JavaScript. A server secret
 * that ever gets that prefix — or a value accidentally interpolated into a component —
 * ships to every visitor. This scan is the mechanical backstop for that class of mistake
 * (ADR 0003) and runs in CI after the production web build.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUNDLE_DIR = path.join(ROOT, 'apps/web/.next');

/** Env var names that must never appear in client output. */
const FORBIDDEN_NAMES = [
  'DATABASE_URL',
  'OPERATOR_API_KEY_HASH',
  'RECEIPT_SIGNER_PRIVATE_KEY',
  'XLAYER_MAINNET_RPC_URL',
  'XLAYER_TESTNET_RPC_URL',
];

/** Value-shaped patterns that must never appear in client output. */
const FORBIDDEN_PATTERNS = [
  { name: 'hex private key', re: /0x[0-9a-fA-F]{64}\b/ },
  { name: 'postgres connection string', re: /postgres(?:ql)?:\/\/[^\s"']+/ },
  { name: 'bearer token literal', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
];

if (!fs.existsSync(BUNDLE_DIR)) {
  console.error(
    `No web build found at ${path.relative(ROOT, BUNDLE_DIR)}. Run the web build first.`,
  );
  process.exit(1);
}

/** Only client-delivered assets. Server chunks legitimately reference server env. */
const CLIENT_DIRS = [path.join(BUNDLE_DIR, 'static')];
const files = [];
for (const dir of CLIENT_DIRS) {
  if (!fs.existsSync(dir)) continue;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|css|json|html|txt|map)$/.test(e.name)) files.push(p);
    }
  })(dir);
}

const findings = [];
for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  for (const name of FORBIDDEN_NAMES) {
    if (content.includes(name)) {
      findings.push(`${path.relative(ROOT, file)}: contains server env name "${name}"`);
    }
  }
  for (const { name, re } of FORBIDDEN_PATTERNS) {
    const m = re.exec(content);
    if (m) {
      findings.push(`${path.relative(ROOT, file)}: matches ${name} (${m[0].slice(0, 12)}…)`);
    }
  }
}

if (findings.length > 0) {
  console.error('Secret material found in the browser bundle:\n');
  for (const f of findings) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`Browser bundle scan: OK (${files.length} client assets, 0 findings).`);
