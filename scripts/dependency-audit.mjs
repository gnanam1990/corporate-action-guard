#!/usr/bin/env node
/**
 * Dependency audit that distinguishes a finding from an outage.
 *
 * `pnpm audit` calls registry.npmjs.org. When that endpoint is down it exits non-zero with
 * a timeout, which is indistinguishable from "a high-severity vulnerability was found" to
 * a CI job that only reads the exit code. That took main red for an outage.
 *
 * It is also inconsistent with a rule this repository already applies elsewhere: live
 * third-party probes are deliberately kept out of required checks, because a third party
 * being down must never block a merge. The audit depends on a third party too.
 *
 * So: a real finding FAILS. An unreachable advisory service WARNS and continues, loudly
 * enough to be noticed in the log. It is never silently skipped, and an outage does not
 * become a way to smuggle a vulnerable dependency through — the next successful run
 * catches it, and the scheduled run exists for exactly that.
 */
import { spawnSync } from 'node:child_process';

/**
 * Bounded. pnpm's own retry ladder is 10s then 60s, so a hard outage can hold the job for
 * minutes before it gives up — long enough that the CI timeout, not the audit, decides the
 * outcome. Cap it here so the wrapper stays in control of the verdict.
 */
const TIMEOUT_MS = Number(process.env['AUDIT_TIMEOUT_MS'] ?? 90_000);

const result = spawnSync('pnpm', ['audit', '--audit-level', 'high', '--json'], {
  encoding: 'utf8',
  cwd: process.cwd(),
  timeout: TIMEOUT_MS,
});

const timedOut =
  result.error !== undefined && 'code' in result.error && result.error.code === 'ETIMEDOUT';
const combined = `${result.stdout ?? ''}${result.stderr ?? ''}${
  timedOut ? '\nkilled by the wrapper timeout' : ''
}`;

/** Symptoms of the advisory endpoint being unavailable, rather than a finding. */
const OUTAGE_SIGNALS = [
  /killed by the wrapper timeout/,
  /operation was aborted due to timeout/i,
  /TimeoutError/,
  /error \(5\d\d\)/,
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/,
  /request to .*registry\.npmjs\.org.* failed/i,
];

function hasFindings(output) {
  try {
    const parsed = JSON.parse(output);
    const counts = parsed.metadata?.vulnerabilities ?? {};
    return (counts.high ?? 0) > 0 || (counts.critical ?? 0) > 0;
  } catch {
    // Not JSON — fall back to the human-readable marker.
    return /vulnerabilit(y|ies) found/i.test(output) && !/No known vulnerabilities/i.test(output);
  }
}

if (result.status === 0) {
  console.log('Dependency audit: OK (no high or critical advisories).');
  process.exit(0);
}

if (hasFindings(result.stdout ?? '')) {
  console.error('Dependency audit FAILED — high or critical advisories found:\n');
  console.error(result.stdout);
  process.exit(1);
}

if (OUTAGE_SIGNALS.some((re) => re.test(combined))) {
  console.error(
    '::warning::Dependency audit could not run — the npm advisory service is unreachable.',
  );
  console.error('This is NOT a clean audit. It is an outage, and the result is unknown.');
  console.error('The scheduled run will re-check; a real finding still fails this job.\n');
  console.error(combined.split('\n').slice(-6).join('\n'));
  process.exit(0);
}

// Neither a recognised finding nor a recognised outage: fail, rather than assume it is fine.
console.error(`Dependency audit exited ${result.status} for an unrecognised reason:\n`);
console.error(combined);
process.exit(1);
