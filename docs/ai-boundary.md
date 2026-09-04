# AI boundary

## The claim

**Disabling this module entirely changes nothing about the product's safety or its core
function.**

That is not a policy statement, it is an architectural fact, and it is asserted by test.

## Why it is drawn this hard

A language model is a plausible-text generator. It is genuinely useful for helping a human
read forty journal events quickly, and it has no business anywhere near the question of
whether money moves.

The failure mode is not that a model gives a wrong answer. It is that a model gives a
_confident, fluent, well-formatted_ wrong answer, at 3 a.m., to someone deciding whether to
override a block.

## How the exclusion is enforced

| Control                                                    | Mechanism                                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Cannot import the domain, receipts, db, reconciler, or api | Layering rule lists `@cag/explainer` as **isolated**: it may import _no_ workspace package                        |
| Declares no workspace dependency                           | Asserted against its own `package.json`                                                                           |
| Cannot express a decision                                  | It receives the decision as an **input**; a test asserts no `evaluate`/`authorize`/`sign`/`issue` function exists |
| Cannot be reached by the money path                        | Nothing imports it; `pnpm arch:check` fails if that changes                                                       |

The check is mechanical because a comment saying "don't do this" is not a control.

## Data flow

```text
journal ──(redacted, delimited)──► explainer ──► validated ──► console panel
   │                                                              (labelled
   └──────────► domain ──► decision ──► receipt                non-authoritative)
                  ▲
                  └─ the explainer never touches this path
```

Only redacted summaries reach the module. It never sees a raw payload, a private key, an
authorization header, or personal data — the journal already refuses secret-bearing keys at
write time, and the caller redacts again before calling.

## Output validation

A model response is validated before anyone sees it. Three rules matter most:

1. **Every citation must be an event id that was actually supplied.** A confident reference
   to `evt-999` when no such event exists is the classic hallucination, and it is rejected.
2. **Every suggested action must come from an allowlist** mapped to runbook procedures. A
   model asked "what should I do" will eventually suggest working around the block. Free-form
   advice is not accepted.
3. **`nonAuthoritative: true` is set by the validator, not read from the response.** The
   model cannot claim authority for itself.

Also rejected: invalid JSON, missing fields, responses over 32 KiB, and a factual response
citing nothing at all.

## Prompt injection

Evidence is written by external sources. Some of it will eventually contain
`ignore previous instructions`.

Every evidence item is wrapped in a delimiter, and any closing delimiter smuggled into the
content is neutralised so it cannot terminate the block it sits inside. The instruction text
itself is **preserved** rather than stripped — an operator should be able to see exactly what
the source said.

## The fallback is deliberately good

When the provider is unavailable or the output fails validation, a deterministic explanation
is generated from reason codes alone.

That fallback is written to be genuinely useful, and that is a safety decision rather than a
courtesy. **If the fallback were poor, there would be pressure to accept unvalidated model
output — and at that moment the model is in the decision path.** A test asserts the fallback
carries real content.

## What is NOT implemented

No provider is wired in. The package contains the boundary, the validation, the injection
handling, and the fallback — the parts that make an integration safe — but no call to any
model API.

That is deliberate for this build: the deterministic product is the thing worth showing, and
the module is optional by design. Wiring a provider is a small change against a boundary that
is already tested.

## Known failure modes, accepted

| Mode                                            | Consequence                                             | Why acceptable                                                    |
| ----------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------- |
| The model produces a fluent but shallow summary | An operator reads less carefully                        | The deterministic reason codes are shown alongside, not replaced  |
| Validation rejects a correct explanation        | The fallback is shown instead                           | Failing toward the deterministic text is the safe direction       |
| A provider logs the prompt                      | Redacted evidence summaries are exposed to the provider | No secrets, no raw payloads, no personal data are ever sent       |
| The panel is mistaken for authoritative         | An operator over-trusts it                              | Labelled in the payload, in the UI, and in the schema type itself |
