#!/usr/bin/env node
/**
 * Refuse to ship committed secret material.
 *
 * Scans tracked files for secret-shaped values. A private key or live API key reaching
 * source control is unrecoverable — it must be rotated, not deleted — so this is a hard
 * gate rather than a warning.
 *
 * Deliberately narrow to keep it triageable: a noisy scanner that nobody reads is worse
 * than none.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const RULES = [
  {
    name: 'hex private key (32 bytes)',
    re: /\b0x[0-9a-fA-F]{64}\b/g,
    // A 32-byte hex value is also a hash, a digest, and a block hash — all of which are
    // legitimately everywhere in this repository. Only flag ones sitting in an assignment
    // that names them as a key.
    contextRe: /(?:private[_-]?key|secret|mnemonic|seed)\s*[:=]\s*['"]?$/i,
    requiresContext: true,
  },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g, requiresContext: false },
  {
    name: 'live Stripe-style key',
    re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
    requiresContext: false,
  },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, requiresContext: false },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, requiresContext: false },
  {
    name: 'private key block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    requiresContext: false,
  },
  {
    name: 'connection string with password',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@'"]+:[^\s:@'"]+@/g,
    requiresContext: false,
  },
];

/**
 * Explicit, reviewable exception marker.
 *
 * Put `secret-scan:allow` in a comment on the same line. Used for deliberately
 * secret-shaped TEST canaries — a redaction test needs a value that looks exactly like the
 * real thing, or it proves nothing. Weakening the canary would weaken the test; weakening
 * the scanner would weaken every file. An inline marker keeps the exception visible to a
 * reviewer instead.
 */
const ALLOW_MARKER = 'secret-scan:allow';

/** Values that are legitimately in the repository and are not secrets. */
const ALLOWED = [
  // The documented local development credential, which is also in .env.example.
  'postgresql://guard:guard@localhost:55432/guard',
  'postgresql://guard:guard@localhost:5432/guard',
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  'out',
  'cache',
  'lib',
  'coverage',
]);

function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

const findings = [];

for (const relative of trackedFiles()) {
  if (relative.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
  const absolute = path.join(ROOT, relative);
  if (!fs.existsSync(absolute) || fs.statSync(absolute).isDirectory()) continue;

  const content = fs.readFileSync(absolute, 'utf8');
  const lines = content.split('\n');

  for (const rule of RULES) {
    for (const [index, line] of lines.entries()) {
      rule.re.lastIndex = 0;
      let match;
      while ((match = rule.re.exec(line)) !== null) {
        const value = match[0];
        if (line.includes(ALLOW_MARKER)) continue;
        if (ALLOWED.some((a) => value.includes(a) || line.includes(a))) continue;

        if (rule.requiresContext) {
          const before = line.slice(0, match.index);
          if (!rule.contextRe.test(before)) continue;
        }

        findings.push(`${relative}:${index + 1}: ${rule.name} — ${value.slice(0, 14)}…`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error('Secret material found in tracked files:\n');
  for (const f of findings) console.error(`  - ${f}`);
  console.error('\nA committed secret must be ROTATED, not merely deleted from history.');
  process.exit(1);
}

console.log('Secret scan: OK (no secret material in tracked files).');
