#!/usr/bin/env node
/**
 * Mutation test for the safety predicate.
 *
 * The repository has no mutation-testing framework, so this is the explicit form the
 * module requires: flip each predicate in `evaluatePreflight` one at a time and prove the
 * test suite FAILS for every mutant. A mutant that survives means the suite would not
 * notice that safety check being removed.
 *
 * The original file is restored in a finally block and the restore is verified by hash.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_TARGET = 'packages/domain/src/preflight.ts';

/** Each mutation removes or inverts exactly one guard. */
const MUTANTS = [
  {
    id: 'unsupported-chain',
    from: 'if (!input.supportedChainIds.includes(action.chainId)) {',
    to: 'if (false) {',
  },
  {
    id: 'evidence-chain-binding',
    from: 'if (input.evidenceChainId === undefined || input.evidenceChainId !== action.chainId) {',
    to: 'if (false) {',
  },
  {
    id: 'allowed-target',
    from: 'if (!input.supportedTargets.some((target) => addressEquals(target, action.target))) {',
    to: 'if (false) {',
  },
  {
    id: 'allowed-action',
    from: 'if (!input.supportedActionTypes.includes(action.actionType)) {',
    to: 'if (false) {',
  },
  { id: 'unknown-asset', from: 'if (!input.assetKnown) {', to: 'if (false) {' },
  { id: 'zero-amount', from: 'action.amount <= 0n', to: 'action.amount < 0n' },
  {
    id: 'non-canonical-token',
    from: '!addressEquals(input.registryTokenAddress, action.assetAddress)',
    to: 'false',
  },
  {
    id: 'non-canonical-wrapper',
    from: '!addressEquals(input.registryWrapperAddress, action.wrapperAddress)',
    to: 'false',
  },
  {
    id: 'outdated-wrapper',
    from: 'if (input.registryWrapperIsCurrent !== true) {',
    to: 'if (false) {',
  },
  {
    id: 'wrapper-asset-relation',
    from: '!addressEquals(input.observedWrapperAsset, action.assetAddress)',
    to: 'false',
  },
  {
    id: 'canonicality-matrix',
    from: "if (input.canonicality.outcome !== 'PASS') {",
    to: 'if (false) {',
  },
  {
    id: 'api-freshness',
    from: '} else if (isStale(input.apiObservedAt, now, input.freshness.apiMaxAge)) {',
    to: '} else if (false) {',
  },
  {
    id: 'chain-freshness',
    from: '} else if (isStale(input.chainObservedAt, now, input.freshness.chainMaxAge)) {',
    to: '} else if (false) {',
  },
  {
    id: 'source-agreement',
    from: "if (input.sourceComparison.agreement !== 'MATCH') {",
    to: 'if (false) {',
  },
  {
    id: 'source-incomplete-passes',
    from: "if (input.sourceComparison.agreement !== 'MATCH') {",
    to: "if (input.sourceComparison.agreement === 'MISMATCH') {",
  },
  {
    id: 'nonce-equality',
    from: 'input.onChainMultiplierNonce !== action.expectedMultiplierNonce',
    to: 'false',
  },
  { id: 'guard-window', from: 'if (isInGuardWindow(window, now)) {', to: 'if (false) {' },
  {
    id: 'unapplied-action',
    from: '} else if (now > window.end) {',
    to: '} else if (false) {',
  },
  {
    id: 'guard-window-exclusive-start',
    from: 'return now >= window.start && now <= window.end;',
    to: 'return now > window.start && now <= window.end;',
    file: 'packages/domain/src/lifecycle.ts',
  },
  {
    id: 'guard-window-exclusive-end',
    from: 'return now >= window.start && now <= window.end;',
    to: 'return now >= window.start && now < window.end;',
    file: 'packages/domain/src/lifecycle.ts',
  },
  { id: 'manual-review', from: 'if (input.manualReviewOpen) {', to: 'if (false) {' },
  {
    id: 'digest-binding',
    from: 'if (r.recomputedOperationDigest !== r.boundOperationDigest) {',
    to: 'if (false) {',
  },
  {
    id: 'receipt-not-yet-valid',
    from: "if (now < r.validAfter) reasons.push('RECEIPT_NOT_YET_VALID');",
    to: "if (false) reasons.push('RECEIPT_NOT_YET_VALID');",
  },
  {
    id: 'receipt-expiry-inclusive',
    from: "if (now >= r.validUntil) reasons.push('RECEIPT_EXPIRED');",
    to: "if (now > r.validUntil) reasons.push('RECEIPT_EXPIRED');",
  },
  {
    id: 'receipt-consumed',
    from: "if (r.consumed) reasons.push('RECEIPT_CONSUMED');",
    to: "if (false) reasons.push('RECEIPT_CONSUMED');",
  },
  {
    id: 'staleness-boundary',
    from: 'return ageAt(observedAt, now) >= limit;',
    to: 'return ageAt(observedAt, now) > limit;',
    file: 'packages/domain/src/time.ts',
  },
  {
    id: 'decision-threshold',
    from: "decision: ordered.length === 0 ? 'ALLOW' : 'BLOCK',",
    to: "decision: ordered.length <= 1 ? 'ALLOW' : 'BLOCK',",
  },
];

const hash = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function runSuite() {
  try {
    execFileSync('pnpm', ['exec', 'vitest', 'run', '--project', 'unit', 'packages/domain'], {
      cwd: ROOT,
      stdio: 'pipe',
    });
    return 'passed';
  } catch {
    return 'failed';
  }
}

const touched = [
  ...new Set(MUTANTS.map((m) => path.join(ROOT, m.file ?? 'packages/domain/src/preflight.ts'))),
];
const originals = new Map(touched.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const originalHashes = new Map(touched.map((f) => [f, hash(f)]));

const survivors = [];
const notApplied = [];

try {
  // Sanity: the suite must be green before mutating, or "failed" means nothing.
  if (runSuite() !== 'passed') {
    console.error('Baseline suite is not green. Fix the suite before running mutation tests.');
    process.exit(2);
  }
  console.log('baseline: PASSED\n');

  for (const mutant of MUTANTS) {
    const file = path.join(ROOT, mutant.file ?? DEFAULT_TARGET);
    const original = originals.get(file);
    if (!original.includes(mutant.from)) {
      notApplied.push(mutant.id);
      console.log(`  SKIP  ${mutant.id.padEnd(30)} anchor not found`);
      continue;
    }
    fs.writeFileSync(file, original.replace(mutant.from, mutant.to));
    const outcome = runSuite();
    fs.writeFileSync(file, original);

    if (outcome === 'passed') {
      survivors.push(mutant.id);
      console.log(`  ALIVE ${mutant.id.padEnd(30)} suite still passed — NOT DETECTED`);
    } else {
      console.log(`  KILLED ${mutant.id.padEnd(29)} suite failed as required`);
    }
  }
} finally {
  for (const [file, content] of originals) fs.writeFileSync(file, content);
  for (const [file, expected] of originalHashes) {
    if (hash(file) !== expected) {
      console.error(
        `RESTORE FAILED for ${path.relative(ROOT, file)} — restore it from git before continuing.`,
      );
      process.exit(3);
    }
  }
  console.log('\nall source files restored and hash-verified');
}

const killed = MUTANTS.length - survivors.length - notApplied.length;
console.log(
  `\n${killed}/${MUTANTS.length} mutants killed, ${survivors.length} survived, ${notApplied.length} not applied`,
);
if (survivors.length > 0) {
  console.error(`\nSurviving mutants (the suite does not detect these): ${survivors.join(', ')}`);
  process.exit(1);
}
if (notApplied.length > 0) {
  console.error(`\nMutants whose anchor no longer matches the source: ${notApplied.join(', ')}`);
  process.exit(1);
}
