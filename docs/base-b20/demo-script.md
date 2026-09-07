# B20 demo — script and shot list

Ninety seconds, one claim, one number. The claim is that an integration can be wrong about a
tokenized stock in a way that does not revert and reconciles against itself. The number is
$2,000 where the answer is $200.

Everything below is reproducible from a clean checkout. Nothing is staged, and the two
commands are the same ones CI runs.

## Before recording

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm b20:proof          # live Base mainnet read + the replay; writes the evidence artifact
pnpm --filter @cag/web dev
```

`pnpm b20:proof` needs network access to Base mainnet. It reads and never writes. If the RPC
is unreachable it says so and records the gap rather than substituting a fixture — which is
correct behaviour but makes for a poor recording, so check it succeeded before you start.

## Shot list

**0:00–0:12 — the problem, stated once.**
Terminal, `pnpm b20:proof` mid-run, on section 3. Voiceover: _"A tokenized stock on Base has
three numbers that all look like 'how much stock is this'. Two of them get confused, and
neither mistake reverts."_

**0:12–0:30 — the live read.**
Section 1 of the output. AAPLc, the real contract address, a real Base mainnet block number
and hash, `decimals 8`, `multiplier 1.0`. Voiceover: _"This is Apple on Base, read at a
confirmed block. Identity is chain plus address — never the ticker, which the issuer can
change."_

**0:30–0:45 — what the chain will not say.**
Section 2. `newUIMultiplier() NOT_DIALED`. Voiceover: _"The scheduling surface isn't dialed on
Base today, so there is no readable pending corporate action. We report that we cannot answer.
We do not report 'nothing is scheduled' — that is the false negative that costs money."_

**0:45–1:05 — the divergence. This is the shot.**
Cut to the browser at `/b20`, the split table centred. Hold on the three rows.
Voiceover: _"Replay a ten-for-one split. One integration reads the balance as a share count
and reports one share. One multiplies the new share count by the Chainlink price — which
already contains the multiplier — and reports two thousand dollars. The right answer is two
hundred. Nothing reverted. Both wrong answers reconcile against themselves."_

**1:05–1:20 — the suite.**
Scroll to the conformance panel, or cut back to section 4 of the terminal. Voiceover: _"Eight
real integration bugs, each caught by the scenario aimed at it. A suite that only ever sees
correct code proves nothing about itself."_

**1:20–1:30 — the boundary.**
Hold on the "What this does not claim" panel. Voiceover: _"A holder can call the token
directly and bypass us entirely. We have a passing test that asserts it. No corporate action
has happened on Base yet — this is a replay. No customers, no audit, no mainnet writes."_

## Rules for the recording

- **Never crop the RECORDED REPLAY banner out of a `/b20` shot.** The page says it twice on
  purpose. A frame that shows the numbers without the label is the same error the product
  exists to catch, committed by us.
- Do not say "prevents", "blocks all", or "protects Base". Say _"for funds routed through the
  adapter"_.
- Do not imply an incident happened on Base. None has been observed; the failure class is
  evidenced from comparable tokenized-stock systems, not from a Base customer loss.
- The block number and artifact digest on screen should match `docs/evidence/b20-end-to-end.md`
  in the repo at the commit you record from. A reviewer who checks will check that.

## What a reviewer can reproduce

| Claim on screen                                        | Reproduce with                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| AAPLc identity and multiplier at a real block          | `pnpm b20:proof`                                                |
| `newUIMultiplier()` is `NOT_DIALED`                    | `pnpm b20:provenance:check`                                     |
| $200 vs $2,000 after a 10:1 split                      | `pnpm b20:proof`, or `pnpm test -- conformance`                 |
| Eight integration defects caught                       | `pnpm test -- conformance`                                      |
| The adapter refuses a receipt after a mid-flight split | `pnpm test:contracts`                                           |
| The direct-transfer bypass exists                      | `pnpm test:contracts` — `test_DirectTransferBypassesTheAdapter` |
