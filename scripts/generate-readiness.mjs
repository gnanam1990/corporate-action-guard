#!/usr/bin/env node
/**
 * Generate docs/build-readiness.md from docs/modules.json.
 *
 * Why this exists: the readiness table was hand-maintained and edited by string
 * replacement. A formatter realigned its columns, every subsequent replacement stopped
 * matching, and the edits no-opped **silently**. For eleven commits the one document whose
 * entire job is to be an honest inventory claimed nothing had been built.
 *
 * The fix is not "be more careful". It is to make the document derived, and to make CI fail
 * when it is stale. Run with `--check` to verify without writing.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MANIFEST = path.join(ROOT, 'docs/modules.json');
const TARGET = path.join(ROOT, 'docs/build-readiness.md');

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

const BADGE = {
  IMPLEMENTED: '**IMPLEMENTED**',
  PARTIAL: '**PARTIAL**',
  ABSENT: 'ABSENT',
};

const counts = manifest.modules.reduce((acc, m) => {
  acc[m.status] = (acc[m.status] ?? 0) + 1;
  return acc;
}, {});

const rows = manifest.modules
  .map((m) => `| ${m.id} | ${m.name} | ${BADGE[m.status]} | ${m.note} |`)
  .join('\n');

const document = `<!--
  GENERATED FILE — do not edit by hand.

  Source of truth: docs/modules.json
  Regenerate:      node scripts/generate-readiness.mjs
  CI check:        node scripts/generate-readiness.mjs --check

  This file was previously hand-maintained. A formatter realigned its columns, the string
  edits that updated it silently stopped matching, and for eleven commits it claimed nothing
  had been built. Generating it is the fix.
-->

# Build readiness

**Recorded at:** ${manifest.recordedAt}.

The honest inventory. A module is \`IMPLEMENTED\` only when its code exists in this
repository and its own gates have been run. Being described in the prompt pack is not
evidence that anything exists.

**${counts.IMPLEMENTED ?? 0} implemented · ${counts.PARTIAL ?? 0} partial · ${counts.ABSENT ?? 0} absent**, of ${manifest.modules.length} modules.

## Status

| #   | Module | Status | Note |
| --- | ------ | ------ | ---- |
${rows}

## Blocked items

These cannot be completed from this environment as configured, and are recorded as blocked
rather than quietly skipped.

| Item | Blocker | Effect |
| --- | --- | --- |
| Deployed environment URLs | No hosting target configured | No live URL may be claimed |
| Production signer and operations | No production AWS KMS/IAM, hosted monitoring, alert delivery, retention, or operating history | Testnet proof is application evidence, not a production-readiness claim |
| Independent security audit | No external reviewer has audited the service or contracts | The repository's internal review cannot be called an audit |
| Verified production xStocks scheduling ABI | The explorer serves no verified ABI without an API key, and no corporate action occurred in the observable log window | Read selectors are confirmed and implemented. The three multiplier **event** signatures are declared \`UNSUPPORTED_CAPABILITY\` rather than invented. Costs the safety path nothing: the verified reads give schedule state directly |
| ESLint on TypeScript 7 | \`typescript-eslint@8\` refuses to load against the TypeScript 7 API | TypeScript pinned to 6.0.3 so lint can run |

## Resolved blockers

| Item | Resolved |
| --- | --- |
| Live xStocks API verification | 2026-09-03 — contract downloaded and verified against production; 4 live contract tests pass |
| Live X Layer mainnet smoke read | 2026-09-03 — 11 live read-only tests pass against chain 196 |
| Live monitoring pipeline | 2026-09-04 — worker discovered 726 assets over 8 pages, observed mainnet at block 69713901, and the console and CLI rendered that evidence. Chain binding intentionally prevents this mainnet evidence from authorizing a testnet receipt |
| Historical v1 testnet proof | 2026-09-04 — 8/8 scenarios recorded with real chain-1952 transaction hashes. Superseded by implementation v2 and retained only as historical evidence |
| Current v2 testnet proof | 2026-09-05 — implementation v2 deployed at block 40163577; 8/8 adversarial scenarios passed and authenticated API-to-vault execution succeeded |

## Hackathon eligibility uncertainty

- The OKX Dev Day 2026 build window is stated as 17–25 September 2026, with project
  submission listed for 25 September. The application deadline is 11 September at 23:59 UTC.
- Whether pre-window implementation is permitted is **UNKNOWN**. This repository is being
  built before 17 September 2026; if OKX requires all implementation to occur inside the
  window, this work counts as preparation only and the submission must say so. Every commit
  carries its authored date, so the record is auditable either way.
- Selected-team technical requirements are not yet published and must be rechecked.
`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
  if (current !== document) {
    console.error(
      'docs/build-readiness.md is stale.\n\n' +
        'Edit docs/modules.json, then run: node scripts/generate-readiness.mjs',
    );
    process.exit(1);
  }
  console.log('Build readiness: OK (generated document matches docs/modules.json).');
  process.exit(0);
}

fs.writeFileSync(TARGET, document);
console.log(
  `Wrote docs/build-readiness.md — ${counts.IMPLEMENTED ?? 0} implemented, ` +
    `${counts.PARTIAL ?? 0} partial, ${counts.ABSENT ?? 0} absent.`,
);
