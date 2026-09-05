# Deployment artifacts

Artifacts are written only after post-broadcast bytecode verification. No artifact means
nothing has been deployed. Never hand-write one.

## Current X Layer testnet deployment

Implementation v2 was compiled from contract source equivalent to commit
`2287207e3b02f697bd5356b72d3ad2d8e8a165bd` and deployed on X Layer testnet (chain 1952) at
block `40163577`.

| Contract | Address |
| --- | --- |
| FixtureAsset | `0x2347e05FBBd4A2D8ee801FBb67fE745BC2A2ea82` |
| FixtureWrapper | `0x3aa6f9def25083C312c88AC190Fa3EEA9Fdd857B` |
| LegacyFixtureWrapper | `0x88a8a0Fb74193C78D733977ea413e44Acd154c3e` |
| ActionGuardAdapter | `0xdF956baCC769d11fEb9eee9ee026b620E7dF4533` |
| ProtectedVault | `0xFAAbCA06d0c91A025D11FFFb7719E32532d8f651` |

The machine-readable source of truth is `xlayer-testnet.json`. Current 8/8 adversarial
evidence is in `docs/evidence/release-candidate.md`; the authenticated API-to-vault proof is
in `docs/evidence/end-to-end-preflight.md`.

## Historical v1 deployment

The superseded v1 adapter at `0x5419941472c4a42FF0D68694c2A88F1b4716C337`
(block `40037372`) remains historical evidence only. Current clients require implementation
version 2 and must never use it as the active deployment.

Reproduce the current deployment and evidence with:

```bash
pnpm testnet:status
pnpm testnet:deploy
pnpm testnet:prove
```
