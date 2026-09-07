# ADR 0005 — Base B20 is an additive extension, not a second product

- **Status:** Accepted
- **Date:** 2026-09-07
- **Extends:** ADR 0001 (stack and repository layout), ADR 0002 (trust and enforcement boundary)
- **Driven by:** live verification of `base/base-std` at commit `be6d0450` and of Base
  mainnet chain 8453 at block 50993686

## Context

Corporate Action Guard ships a working X Layer product: an append-only evidence journal,
fail-closed preflight, EIP-712 receipts, a reconciler, an SDK and an operations console.
Coinbase Tokenized Stocks on Base present the same class of failure — an integration silently
losing the meaning of a share when a multiplier moves — against a different token standard,
a different price source and a different chain.

The tempting move is a new repository under a new name. That would duplicate the journal, the
idempotency work, the receipt signing boundary, the layering rule and the console, and would
leave two implementations of the one thing that is hard to get right: refusing to authorize on
incomplete evidence.

## Decision

Base B20 support is an **additive extension of this repository**. Concretely:

- Existing packages keep their names, public APIs and layer numbers. `xstocks-client` and
  `xlayer-reader` are not renamed, rewritten or generalized "while we are in there".
- New Base-specific responsibilities go in new packages — `b20-reader`, `chainlink-reader`,
  `equity-ledger`, `conformance` — each with one reason to exist and one layer.
- Shared packages (`domain`, `config`, `db`, `receipts`, `reconciler`, `sdk`, `observability`)
  are **extended**, never repurposed. Existing X Layer reason codes, receipt vectors, journal
  event versions and API routes remain byte-compatible.
- The mechanical layering check (`pnpm arch:check`) gains the new packages, so a Base package
  importing an app or a same-layer sibling fails the build exactly as it does today.
- Base surfaces live under a `/v1/b20` API namespace and a `/b20` web route. There is one
  Fastify server and one worker process; a second server would mean a second authentication
  and idempotency implementation.

An X Layer behaviour change requires its own ADR and a compatibility test. "The Base work
needed it" is not a justification.

## Provenance is a build gate, not a comment

No Base address, ABI, event, selector or capability enters production code except through
`provenance/base-b20/`, which is produced by `scripts/b20-provenance.mjs` from primary sources
and live reads at a recorded block. `check` re-reads and diffs; drift exits non-zero. Nothing
auto-accepts a changed address or capability.

## Consequences

- One journal, one idempotency implementation, one signer boundary, one console shell.
- The X Layer regression surface is explicit and testable: every existing test stays green,
  unmodified, in every Base pull request.
- New packages carry the cost of the layering rule, which is the point — it is what stops a
  reader reaching into the API or the domain reaching for a clock.
- The repository grows large enough that module ownership has to be written down. It is, in
  `docs/base-b20/implementation-sequence.md`.

## Rejected alternatives

**A separate `equity-os` repository.** Duplicates the journal, receipts and idempotency; two
places to fix a fail-closed bug; no shared conformance corpus.

**Generalizing `xlayer-reader` into a multi-chain reader now.** A refactor of working,
tested, deployed code to serve a chain whose capability surface is still moving. The B20
reader is a separate package; if a genuine shared abstraction appears after both exist, that
is a later ADR with a migration test.

**Feature-flagging Base inside the existing xStocks routes.** Would let a Base failure change
an X Layer decision path. The namespaces stay separate.
