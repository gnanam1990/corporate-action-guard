# OKX Dev Day 2026 — builder application draft

**Verified application deadline:** 11 September 2026, 23:59 UTC.  
**Primary track:** X Layer: Tokenized stocks and RWA.  
**Team name:** Corporate Action Guard.

The application form also requires the applicant's name, email, country of residence,
Telegram username, team size, and whether a team member can attend Singapore on 6 October.
Those are personal declarations and must come from the applicant.

## Tell us about your team. What is your background?

We are building safety and reliability infrastructure for tokenized real-world assets. Our
prototype combines a TypeScript/Fastify API, PostgreSQL evidence journal, Next.js operator
console, live xStocks API ingestion, read-only X Layer observations, an integration SDK,
and Foundry-tested Solidity contracts. We focus on making evidence boundaries explicit:
unknown, stale, missing, or contradictory data must block rather than silently authorize an
operation. The public repository includes architecture decisions, a threat model, operational
runbooks, automated security checks, and reproducible tests.

## What do you plan to build? Briefly describe the problem and your solution.

Corporate actions such as splits can change an xStock's wrapper or multiplier while an
integration is preparing a transfer, collateral update, or settlement. A transaction formed
from stale assumptions may still execute. Corporate Action Guard compares the live xStocks
API with independent confirmation-safe X Layer reads and fails closed on missing, stale, or
disagreeing evidence. For an allowed operation it issues a short-lived EIP-712 receipt bound
to the exact chain, target, asset, amount, recipient, and multiplier nonce. An opt-in X Layer
adapter rechecks those facts onchain and rejects mutated, replayed, expired, or guard-window
transactions. The working prototype includes a live coverage console, API/SDK, durable audit
journal, and a labelled testnet fixture for reproducible failure proofs. It does not claim to
protect direct ERC-20 transfers that bypass the adapter.

## Links and evidence to keep ready

- Repository: https://github.com/gnanam1990/corporate-action-guard
- Current CI: https://github.com/gnanam1990/corporate-action-guard/actions
- Application page: https://luma.com/l4aq8vii
- Current testnet evidence: `docs/evidence/release-candidate.md`
- Authenticated API-to-vault proof: `docs/evidence/end-to-end-preflight.md`
- Three-to-five-minute presentation: `docs/demo-script.md`

## Claims boundary

Do not claim that the project is externally audited, universally protects X Layer, has
production traction, or supports production xStocks scheduling semantics. Describe it as a
working prototype with live reads and independently reproducible testnet enforcement proof.
