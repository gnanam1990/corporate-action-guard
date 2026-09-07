# ADR 0008 — An untyped multiplier change is not a classified corporate action

- **Status:** Accepted
- **Date:** 2026-09-07
- **Extends:** ADR 0002 (trust and enforcement boundary)
- **Driven by:** the observed Base mainnet capability surface — the scheduled-multiplier
  surface is not dialed, so a mainnet action arrives as a bare instant `MultiplierUpdated`
  with no structured type

## Context

A multiplier moving from `1e18` to `10e18` is an on-chain fact. What it _means_ — forward
split, reinvested dividend, reference change, correction of an earlier error — is a legal and
accounting question the chain does not answer. `IB20Asset.announce` carries a free-text
`description` and a `uri`, both issuer-authored and both untrusted input.

The pressure to guess is real: a 10× increase "obviously" looks like a 10:1 forward split, and
a dashboard that says `FORWARD_SPLIT` reads better than one that says `UNKNOWN`. But a
dividend reinvestment and a small split produce the same shape, tax treatment differs between
them, and a wrong label propagates into a customer's books.

On Base mainnet the problem is sharper than it would be with Cobalt live: with
`newUIMultiplier()` and `effectiveAt()` not dialed, there is no scheduled-action surface to
read, so the _only_ signals are the instant event, the announcement bracket, and the
announcement text.

## Decision

### Facts and classifications are separate, and only facts are authoritative

The lifecycle reducer produces **facts**: which multiplier is active at which block timestamp,
which epoch it belongs to, which events produced it, whether a schedule was cancelled or
superseded. Those are derived only from on-chain evidence with block provenance, and they are
what authorization uses.

Classification is a **separate, downstream, optional** label with its own confidence and its
own evidence chain. A missing or `UNKNOWN` classification never blocks reconciliation of the
underlying state change, and never turns into an authorization result.

### The classification enum, and what may set it

```text
DIVIDEND_REINVESTMENT
FORWARD_SPLIT
REVERSE_SPLIT
SPIN_OFF_OR_REFERENCE_CHANGE
METADATA_ONLY
UNKNOWN
```

A classification becomes `VERIFIED` **only** from explicit structured issuer or reference-data
evidence that passes configured validation. The following may never, alone or together, set a
classification:

- the numeric shape of the multiplier change (`10×` does not mean split);
- the direction of the change;
- the ticker or the asset's name;
- price movement around the event;
- natural-language announcement text;
- any model output.

Everything else stays `UNKNOWN` / `MANUAL_REVIEW` while the on-chain state change is still
fully reconciled and reported.

### Announcement text and URIs are evidence, not instructions

`description` and `uri` are stored with provenance and content hash and rendered as untrusted
data. Fetching a URI, where enabled, is bounded: HTTPS only, allowlisted or resolver-
constrained, no private or link-local addresses, bounded redirects, bounded body, validated
content type, stored body hash. Text inside an announcement that reads like an instruction is
recorded verbatim and obeyed by nothing.

### AI cannot reach the decision path

`@cag/explainer` already imports no workspace package and is enforced by `pnpm arch:check`.
That boundary extends unchanged: a model may render an existing outcome into readable prose;
it may not classify an action, choose an outcome, compute money, or influence a receipt.

### What correlation may conclude

Correlation groups facts into one case by evidence, not by narrative: an announcement bracket
and the calls inside it, a schedule and its cancellation or activation, a pause and its
matching unpause, a feed round that moved in the same direction as the multiplier. It reports
what is missing as explicitly as what is present — no bracket, mismatched announcement ID,
unpause before price and multiplier realign, evidence read at incompatible blocks — and each
of those is a named reason code rather than a lower confidence score.

## Consequences

- The product will show `UNKNOWN` on real Base corporate actions until structured issuer
  evidence is wired in. That is the honest state and it is displayed as such.
- Conformance scenario 1 is exactly this: a dividend-shaped multiplier increase must stay
  `UNKNOWN` without typed evidence. An integration that confidently labels it fails.
- Customers who need typed classification get a named integration point — an operator-reviewed
  issuer or reference-action record — rather than a heuristic that is right most of the time.

## Rejected alternatives

**Heuristic classification with a confidence score.** A number between 0 and 1 attached to a
legal category invites exactly the reliance it disclaims.

**LLM classification of the announcement text with human review.** Puts model output on the
path to a ledger posting, and the review step erodes under volume.

**Deferring classification entirely.** The evidence graph is the product; recording that a
classification is unavailable, and precisely why, is more useful than not modelling it.
