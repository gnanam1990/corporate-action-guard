# The testnet fixture

## Why a fixture exists at all

Real corporate actions cannot be scheduled on demand. The failure this product exists to
prevent — an integration acting on a multiplier that changed a moment ago — cannot be
triggered against production xStocks contracts, because nobody can make Apple do a stock
split to suit a demo.

The fixture makes those failures reproducible on X Layer testnet. It is labelled
`TESTNET FIXTURE` on chain, in metadata, and in the UI.

## What it proves

That the guard **rejects** a stale, mutated, replayed, expired, or unsafe-window operation.
Those are real transactions against a real chain, reverting for real reasons:

| Failure                                 | Test                                           |
| --------------------------------------- | ---------------------------------------------- |
| Receipt replayed after use              | `test_ValidReceiptSucceedsExactlyOnce`         |
| Recipient changed after issuance        | `test_MutatedRecipientIsRejected`              |
| Amount changed after issuance           | `test_MutatedAmountIsRejected`                 |
| A corporate action is scheduled         | `test_ScheduleInvalidatesAnOutstandingReceipt` |
| A schedule is overridden                | `test_OverrideInvalidatesTheReceiptAgain`      |
| Inside the guard window                 | `test_InsideGuardWindowIsRejected`             |
| Receipt expired                         | `test_ExpiredReceiptIsRejected`                |
| Another caller tries to spend it        | `test_AnotherCallerCannotSpendTheReceipt`      |
| A wrapper pointing at a different asset | `test_WrapperPointingAtAnotherAssetIsRejected` |

## What it does NOT prove

**Compatibility with production xStocks scheduling semantics.**

The fixture implements `ICorporateActionAsset` — the four read functions
[verified live on mainnet](integrations/xlayer.md) on 2026-09-03:

```text
getCurrentMultiplier()        -> 1003269012539818700
newMultiplier()               -> 1003269012539818700
newMultiplierNonce()          -> 5
newMultiplierActivationTime() -> 0
```

Compatibility of that **read surface** is evidenced: the same reader and the same adapter
work against both. Compatibility of **scheduling behaviour** is not, and must not be
claimed. How production xStocks schedules, overrides, and activates a multiplier is not
published in a form this build could verify, so the fixture's `scheduleMultiplier` /
`applyScheduledMultiplier` are _a_ reasonable model, not _the_ production model.

This is the production compatibility gap. It is recorded here rather than glossed over.

## Deliberate design choices

**It mirrors the production shape, including the awkward parts.**

The fixture wrapper exposes `asset()` and the conversions but **not** the multiplier
functions, because calling those on the production wrapper reverts. A fixture that exposed
them would let the adapter be written against a shape that does not exist in production,
and the mistake would surface only on mainnet. A test asserts the wrapper's multiplier
surface is absent.

**The nonce advances at schedule time, not at activation time.**

This is what invalidates outstanding receipts _before_ the change takes effect rather than
after. A receipt issued while a change was already scheduled is dead immediately.

**Zero is the "no schedule" sentinel, on chain as in the API.**

`newMultiplierActivationTime() == 0` means no pending action. The adapter checks for the
sentinel explicitly; reading `0` as an instant would place every action inside a guard
window at the Unix epoch and block everything.

**Scheduling into the past is rejected.** Otherwise an operator could skip the guard window
entirely by backdating an activation.

**Applying is permissionless but time-gated.** Anyone may push the state forward once the
admin's committed activation time has passed; nobody can apply it early.

**The nonce is strictly monotonic**, proven by fuzz test, so an old receipt can never become
valid again.

## Security posture

- Narrowly scoped fixture admin: may schedule, override, and nothing else.
- No upgradeability, no delegatecall, no arbitrary external call, no hidden mint authority
  beyond the explicit capped faucet.
- Faucet capped per address, so a publicly reachable faucet cannot be drained into a
  misleading supply figure.
- Checks-effects-interactions throughout; `SafeERC20` for transfers.
- Constructors **revert on any chain but 1952**. A fixture deployed to a production chain
  would be indistinguishable from a real asset to anything reading it.
- It does not use the xStocks name, ticker, or branding.

## On `block.timestamp`

The guard window is inherently a statement about time, and `block.timestamp` is the only
clock available on chain. It is proposer-influenced within a small window. No claim is made
here stronger than that semantics allows: the guard window is a **safety margin measured in
minutes**, deliberately much wider than any plausible timestamp manipulation, not a precise
instant. `forge build` emits `block-timestamp` lint warnings at exactly these lines; they
are expected and are not suppressed.

## Deployment

`script/DeployTestnet.s.sol`, in this order:

1. Refuses chain 196 explicitly, then refuses any chain that is not 1952.
2. Reads the broadcaster from the environment. **No private key appears in source.**
3. Prints every planned address and the chain before broadcasting.
4. Verifies bytecode exists at every address **after** broadcast — a transaction receipt is
   not proof a contract exists.
5. Writes `deployments/xlayer-testnet.json` only once all of the above passed.

Both chain gates are covered by tests (`DeployGuardsTest`), because they are the part of
deployment that must never regress.

An implementation-v1 fixture was deployed and its historical proof is retained in
`docs/evidence/release-candidate.md`. The current contracts declare implementation v2, so
that artifact is obsolete and is rejected by the web loader, status check, and proof
runner. A funded chain-1952 broadcaster and explicit deployment authorization are required
to create current v2 evidence.
