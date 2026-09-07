# Base Batches 004 — application draft

**Verified from base.org/batches on 2026-09-07:** applications open 19 August, **close
9 September**, acceptances 17 September, virtual program 21 September – 15 November, Demo Day
in New York 17 November. Selected teams receive a $100K investment offer from the Base
Ecosystem Fund.

**The form requires a written and a video submission and does not save drafts.** That is why
this document exists: write and check every answer here, then paste.

The exact form questions are not transcribed below. Opening the application creates state
under the applicant's identity, and starting a submission is the applicant's decision, not
something to be done on their behalf. The sections here cover what the public pages ask for
and what an accelerator application of this shape always asks; map them to the live fields
when you open it.

---

## The one-line claim

> We stop tokenized-stock integrations from silently mis-accounting corporate actions, and
> produce evidence that their positions and money-moving actions stayed correct.

Use this wording. It claims a failure class and a work product, and it claims neither
prevention nor coverage we do not have.

---

## What we are building

Corporate Action Guard is correctness infrastructure for Coinbase Tokenized Stocks on Base.

A B20 asset exposes three quantities that all read as "how much stock is this":

```text
rawAmount              balanceOf() — the transfer unit. A corporate action never moves it.
shareEquivalent        floor(rawAmount × multiplierWad / 1e18) — what a holder thinks they own.
totalReturnTokenPrice  floor(underlyingPrice × multiplierWad / 1e18) — what Chainlink publishes.
```

Two of the three get confused, and **neither mistake reverts**:

- Reading `balanceOf` as a share count is correct until the first corporate action, then wrong
  by exactly the multiplier, forever.
- Multiplying the share-equivalent by the Chainlink price applies the multiplier twice,
  because it is already inside that price. After a 10:1 split a $200 position reads as $2,000.

Both wrong answers settle, reconcile against themselves, and are discovered by a customer.

We ingest verified B20 identity, multiplier lifecycle and Chainlink evidence with block and
round provenance; refuse to authorize an operation on stale, contradictory or missing
evidence; and produce a signed, independently verifiable evidence package for what we
allowed and why.

---

## Why us, and why this is not a dashboard

The repository is not a Base-only project that started this month. It is a working
correctness product with an append-only evidence journal, fail-closed preflight, EIP-712
receipts, durable idempotency, a reconciler, an SDK and an operator console — built for
tokenized equities on X Layer and already proven on that testnet. The Base work reuses every
one of those, which is why it went from nothing to nineteen modules in days rather than
months.

The moat is not the multiplier formula. Anyone can write it. It is the accumulated,
versioned combination of verified asset provenance, temporal corporate-action evidence,
replay-resistant receipts, reconciliation history and a mutation-tested conformance corpus
that grows with every integrator defect we see.

---

## The finding that shows the depth of the work

We measured Base rather than assuming it. A B20 token is precompile-backed, and a selector
the current hardfork has not dialed reverts with **exactly its own four bytes** —
`uiMultiplier()` (`0xa60bf13d`) reverts with `0xa60bf13d`. That gives an exact capability
probe, and it produced a consequential answer:

**The Cobalt / ERC-8056 scheduling surface is not dialed on Base mainnet.** `newUIMultiplier()`
and `effectiveAt()` do not answer, so there is _no readable pending corporate action on Base
today_. Our lifecycle reducer returns `UNSUPPORTED_CAPABILITY` rather than "no update is
scheduled" — the latter would be a false negative on the most safety-critical question the
product answers, and it is the answer a team that had assumed rather than measured would ship.

Recorded with provenance at block 50993686 in `docs/base-b20/sources.md`. A test asserts the
observation, so if Cobalt activates our build fails and that path is revisited deliberately.

---

## Traction — stated honestly

We have **no customers, no pilot, no letter of intent and no revenue.** Demand for this is
not proven. Saying otherwise in an application that will be diligenced would be the worst
possible trade.

What we do have is a working system, verified against live Base mainnet state, that a
reviewer can reproduce from a clean checkout in two commands.

The validation plan is the honest version: interview five Base tokenized-stock integrators in
the first two weeks, aim for two concrete workflows or bugs rather than compliments, and get
one integration willing to run the conformance suite. By week four, reproduce one real defect
in partner code or data and secure one paid pilot or signed pilot letter with a named success
metric. If those gates fail, this stays an open-source module rather than becoming a company.

---

## What a reviewer can reproduce

```bash
pnpm install --frozen-lockfile && pnpm build
pnpm b20:proof     # live Base mainnet read, then the 10:1 split replay
pnpm verify        # the full gate
```

| Claim                                                             | Reproduced by               |
| ----------------------------------------------------------------- | --------------------------- |
| AAPLc identity and multiplier at a real Base block                | `pnpm b20:proof`            |
| `newUIMultiplier()` is `NOT_DIALED` on Base mainnet               | `pnpm b20:provenance:check` |
| $200 correct vs $2,000 double-multiplied after a 10:1 split       | `pnpm b20:proof`            |
| Eight real integration defects caught by the conformance suite    | `pnpm test`                 |
| The adapter refuses a receipt after a mid-flight corporate action | `pnpm test:contracts`       |
| A holder can bypass the guard by calling the token directly       | `pnpm test:contracts`       |
| Durable idempotency under eight concurrent callers                | `pnpm test:integration`     |

Numbers as of this draft, all re-run before writing them down: 927 unit tests, 133 integration
tests against real PostgreSQL (15 more skip without a local chain node), 98 Foundry tests, 19
of 35 B20 modules implemented. Quote them with the date attached — they move every day.

---

## Base First — the question we must not dodge

Eligibility says "teams committed to Base as their default implementation and network of
choice." We are not yet able to say Base has always been our default, and pretending
otherwise would not survive five minutes of diligence.

The truthful version, which is also the stronger one:

> The engine was built for tokenized equities on X Layer and is proven there. Base is now the
> larger and faster-moving half of the product: the verified asset registry, the equity
> ledger, the conformance lab, the guard adapter and the preflight matrix are all Base-native
> and were built in the last week. Base is our default implementation going forward, and the
> X Layer work is preserved rather than extended.

If that is not enough for the program, we would rather be told so than be selected on a
misreading.

---

## What we will not claim, anywhere

Written here so it can be checked against the final text before submitting.

- **No universal protection.** Enforcement reaches only funds routed through our adapter or
  vault. A holder can call the B20 token directly and bypass it. A passing Foundry test
  asserts that bypass exists. Never say "prevents", "blocks all" or "protects Base".
- **No observed Base incident.** No Coinbase asset has had a corporate action yet; every one
  reads `multiplier() == 1.0`. The failure class is argued from the mechanics of the three
  quantities, which is checkable, not from a customer loss we witnessed. The
  frequently-repeated RWA.xyz supply-mismatch figures for other tokenized-stock issuers are
  **secondhand in this repository and not independently verified** — read them at the source
  and cite that source, or leave them out.
- **No mainnet writes.** Base mainnet is read-only in this repository, structurally: the
  mainnet configuration has no signer field, and the adapter refuses to deploy on chain 8453
  in its constructor.
- **No audit, no certification, no partnership.** Nothing here has been externally reviewed.
  We are not endorsed by, affiliated with, or certified by Coinbase, Base or Chainlink.
- **No production readiness.** No hosted deployment, no production signer custody, no
  operating history, no SLA.
- **No AI in the decision path.** A model may render an outcome into prose. It may not
  classify a corporate action, choose an outcome, compute money or influence a receipt — and
  that boundary is enforced mechanically by the architecture check, not by policy.
- **No tax or legal advice.** We produce evidence and configurable books-and-records
  projections.

---

## The video — 60 to 90 seconds

Full shot list in `docs/base-b20/demo-script.md`. The spine:

1. The three quantities, and that two of them get confused (0:00–0:12)
2. Live read: AAPLc at a real Base block (0:12–0:30)
3. `newUIMultiplier()` is `NOT_DIALED` — we report we cannot answer (0:30–0:45)
4. **The split. $2,000 wrong, $200 right, nothing reverted.** (0:45–1:05)
5. Eight integration defects caught (1:05–1:20)
6. The boundary: direct calls bypass us, no customers, no audit (1:20–1:30)

One thing to expect when you record: with the API not running, a banner appears above the
page content reading **Source health unknown.** _"The console could not determine whether its
evidence sources are healthy. Treat everything below as unverified."_ (verbatim from
`apps/web/src/components/app-shell.tsx`). That is the product being right, not the page being
broken. Either start the API so it resolves, or leave it in shot and say what it means. Do not
hide it.

**Never crop the RECORDED REPLAY banner out of a `/b20` shot.** The page states it twice on
purpose, and a frame showing the numbers without the label is the same error the product
exists to catch, committed by us.

---

## Links to have ready

- Repository — https://github.com/gnanam1990/corporate-action-guard
- CI — https://github.com/gnanam1990/corporate-action-guard/actions
- Source provenance, including the capability finding — `docs/base-b20/sources.md`
- End-to-end proof artifact — `docs/evidence/b20-end-to-end.md`
- Product contract and the guarantee boundary — `docs/base-b20/product-contract.md`
- The 34 named invariants — `docs/base-b20/invariants.md`
- Honest module inventory — `docs/build-readiness.md`

---

## Personal declarations the form will want

These are the applicant's to supply and are deliberately not filled in here: name, email,
country of residence, team size, company entity status, prior fundraising, and any
scheduling or attendance commitments. Note that eligibility is "pre-product to post-MVP teams
that have not yet raised a formal Seed round" — confirm that holds before submitting.

## Before you submit

- [ ] Re-run `pnpm b20:proof`; the block number and artifact digest on screen in the video
      match `docs/evidence/b20-end-to-end.md` at the commit you record from
- [ ] Every claim above checked against the "what we will not claim" list
- [ ] Video under 90 seconds, replay banner visible in every `/b20` frame
- [ ] The Base First answer says what is true rather than what is wanted
