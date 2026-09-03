# Domain invariants

Normative description of `packages/domain`. Hand-written; not generated from code
comments. Where this document and the code disagree, that is a bug in one of them and the
tests decide.

## Purity

`packages/domain` performs no I/O. No clock, no network, no database, no filesystem, no
environment. `now` is always a parameter. ESLint enforces this — `node:*` imports, `Date`,
`Date.now`, and `process.env` are all errors in this package, and each rule is verified to
fire against a probe file.

The practical consequence: a decision can be recomputed from recorded evidence and produce
a byte-identical result. That is what makes incident replay meaningful rather than
decorative.

## Ties resolve toward blocking

Wherever a boundary could go either way, it blocks. An off-by-one-millisecond ALLOW is a
wrong balance that settles; an off-by-one BLOCK is a retry.

| Boundary                 | Rule      | At the exact instant |
| ------------------------ | --------- | -------------------- |
| Guard window start       | Inclusive | **BLOCK**            |
| Guard window end         | Inclusive | **BLOCK**            |
| Evidence freshness limit | Inclusive | **STALE**            |
| Receipt `validAfter`     | Inclusive | **valid**            |
| Receipt `validUntil`     | Inclusive | **EXPIRED**          |

`deriveGuardWindow(activation, before, after)` produces the closed interval
`[activation - before, activation + after]`. A zero-width window still blocks at exactly
the activation instant.

## Missing evidence is never an implicit match

Three-valued logic is used deliberately. `UNKNOWN` means "not determined" and is distinct
from `FAIL`, because they call for different operator responses — but **neither ever
produces an ALLOW**.

- `summarizeCanonicality` returns `PASS` only when every check is `PASS`. An empty matrix
  is `UNKNOWN`, never `PASS`.
- Any non-`PASS` canonicality outcome contributes a block reason. Every check name maps to
  a reason via an exhaustive `Record<CanonicalityCheckName, BlockReason>`, so adding a
  check without deciding how it blocks is a compile error.
- `compareSources` returns `INCOMPLETE` when either source cannot supply a field.
  `INCOMPLETE` blocks exactly like `MISMATCH`. An absent value is not agreement.
- `MISMATCH` dominates `INCOMPLETE`, which dominates `MATCH`. Disagreement is never
  averaged away.

A property test asserts the general form: removing any subset of evidence can never turn a
`BLOCK` into an `ALLOW`.

## ALLOW is the complete conjunction

`evaluatePreflight` returns `ALLOW` **if and only if** it collected zero reasons. There is
no separate decision flag that could drift from the reason list.

It does not short-circuit. Every check runs and every failure is collected, because an
operator debugging a block needs the whole picture and a single-reason answer hides
compounding faults.

## Reason codes are a stable public contract

`BlockReason` values appear in API responses, the SDK, CLI exit behaviour, the console,
and incident evidence. **Renaming one is a breaking change requiring an ADR.**

Ordering is deterministic: severity first (`SAFETY_CRITICAL` → `EVIDENCE_DEGRADED` →
`INPUT_REJECTED`), then declaration order. Never input order, and never with duplicates. A
caller reading only the first reason gets the most important one.

Every reason carries a severity and a deterministic operator explanation, so the console
can explain any block without an LLM and without inventing a cause.

## Numbers

**Multipliers** are fixed-point: an integer `value` scaled by `10 ** decimals`. A ratio
like 1/3 has no exact IEEE-754 representation, and a lost unit here is a wrong balance.
Comparison rescales both sides to the finer exponent and compares exactly, so `1.50` and
`1.5` are equal while values differing in the eighteenth decimal are not — a distinction
that collapses to equality as doubles.

**Amounts** are `bigint` base units. No floats, no display strings, no
`Number.MAX_SAFE_INTEGER` ceiling.

**Tolerance** for enforcement is `EXACT_TOLERANCE` (zero). A non-zero tolerance exists only
for alerting and never for authorization.

## Addresses

EIP-55 checksums encode capitalization, not identity. All addresses are normalized to
lowercase for storage and comparison, because a false `SOURCE_MISMATCH` created by a casing
difference would block real money. The zero address is never a valid token, wrapper,
recipient, or target.

## Time

Every instant is integer milliseconds since the Unix epoch, UTC. ISO parsing and formatting
are implemented with integer civil-date arithmetic rather than `Date`, so there is no
ambient timezone input anywhere in the package; a cross-check property test asserts
agreement with the platform implementation across the range.

A timestamp arriving without an explicit `Z` or numeric offset is **rejected**, not assumed
to be UTC. Silently assuming a zone on evidence that decides whether money moves is exactly
the class of mistake this product exists to prevent.

A future-dated observation has age zero, never a negative age.

## The state machine

```text
NORMAL -> PENDING -> GUARD_WINDOW -> APPLIED -> RECONCILED
                   \-> MISMATCH -> MANUAL_REVIEW -> RECOVERED
```

Two separate things are modelled and must not be confused:

- `deriveLifecycleState(input, now)` computes the state **implied by evidence**. Pure, no
  memory. Priority order: an unsafe condition outranks a progress condition, so a mismatch
  is reported as `MISMATCH` even mid-guard-window — the operator needs the disagreement,
  not the schedule.
- `legalTransition(from, event)` constrains how **recorded** state may move, so history
  cannot jump illegally.

The transition table is written out in full rather than derived, so an illegal transition
is a data fact a test can assert. Of 72 (state, event) pairs, 17 are legal and 55 are
rejected; the test asserts the implementation table equals the expected table exactly.

Safety-critical rules encoded in the table:

- A mismatch **cannot self-heal**. `MISMATCH -> SOURCE_RECOVERED` is illegal; recovery must
  pass through `MANUAL_REVIEW`.
- `MANUAL_REVIEW_RESOLVED` returns to `MANUAL_REVIEW`, not to `RECOVERED`. An operator
  resolution records a decision; it does not assert that the sources now agree.
- `RECOVERED` is reachable **only** through `SOURCE_RECOVERED` — a later complete
  observation in which the sources actually agree.
- A window that passed with no on-chain effect observed derives `MISMATCH`, not `NORMAL`.
  An unaccounted-for schedule is a disagreement between what was announced and what
  happened.

## Verification

| Check                                                                            | Result                   |
| -------------------------------------------------------------------------------- | ------------------------ |
| Table test per reason code, plus a coverage test that fails if a code has no row | 18/18 codes              |
| Guard-window boundaries at start−1, start, activation, end, end+1                | asserted individually    |
| Property: removing evidence never improves the decision                          | 400 runs                 |
| Property: `ALLOW` iff zero reasons                                               | 500 runs                 |
| Property: window membership is exactly the closed interval                       | 500 runs                 |
| Property: reason ordering is input-order independent and duplicate-free          | 500 runs                 |
| Property: ISO round-trip and agreement with the platform implementation          | 1000 runs                |
| Exhaustive transition table, legal and illegal                                   | 72 pairs                 |
| **Mutation test over every predicate**                                           | **23/23 mutants killed** |

`node scripts/mutate-preflight.mjs` flips each guard in `evaluatePreflight`,
`isInGuardWindow`, and `isStale` one at a time and requires the suite to fail for every
mutant. It restores the sources in a `finally` block and verifies the restore by SHA-256.

Two mutants survived the first run — the operation-digest binding check and the inclusive
upper bound of the receipt validity window — and the tests that kill them were added as a
direct result. That is the intended use: the mutation run is what proves the suite would
notice a safety check being removed.
