# Canonicality

Before a protected action is allowed, six things must be true about the asset it names.
Each is checked separately and reported as `PASS`, `FAIL`, or `UNKNOWN` — never as a single
unexplained boolean, because an operator looking at a block needs to know _which_ of the six
went wrong.

## The matrix

| #   | Check                      | PASS when                                                    | FAIL when                      | UNKNOWN when                                  |
| --- | -------------------------- | ------------------------------------------------------------ | ------------------------------ | --------------------------------------------- |
| 1   | `TOKEN_MATCHES_REGISTRY`   | The chain was read at the address the live registry declares | The addresses differ           | —                                             |
| 2   | `WRAPPER_MATCHES_REGISTRY` | The chain was read at the declared current wrapper           | The addresses differ           | The registry declares no current (v2) wrapper |
| 3   | `TOKEN_HAS_BYTECODE`       | `eth_getCode` returned code at the observed block            | `eth_getCode` returned `0x`    | `eth_getCode` itself failed                   |
| 4   | `WRAPPER_HAS_BYTECODE`     | As above, for the wrapper                                    | As above                       | As above                                      |
| 5   | `WRAPPER_ASSET_RELATION`   | `wrapper.asset()` returns the expected token                 | It returns a different address | The call could not be read                    |
| 6   | `WRAPPER_VERSION_CURRENT`  | The observed wrapper is the current v2 wrapper               | It is a superseded wrapper     | No current version is declared                |

**The overall outcome is `PASS` only when all six pass.** `FAIL` dominates `UNKNOWN`, and a
property test asserts that no `UNKNOWN` check can ever produce a canonical `PASS`.

## Why UNKNOWN is separate from FAIL

They mean different things and call for different operator responses. "The wrapper points at
the wrong asset" is a contract problem; "we could not read `wrapper.asset()`" is an
infrastructure problem. Collapsing them would make missing evidence read as a definite
finding — and, worse, would tempt an implementation into treating "no contradiction found"
as agreement.

Neither ever produces an ALLOW.

## Rules

- **Canonical addresses come from the live API at runtime**, never from a constant list in
  source. A hard-coded registry is a registry that silently goes stale, and this product's
  entire premise is that stale state is dangerous (ADR 0002).
- **An allowlist cache is a performance optimization, not an authority.** It must carry an
  expiry and a source version.
- **Only the current wrapper version is accepted.** `wrapperAddressV2` is the current
  wrapper; `wrapperAddress` (v1) is preserved when present so historical incidents can be
  replayed against the wrapper that was current at the time. A legacy wrapper that still
  holds live bytecode is still a legacy wrapper — check 4 passes and check 6 fails, and the
  action is blocked.
- **Wrapper asset mismatch is a hard block.** It is the check that catches a wrapper
  substituted for a different underlying.
- **Checksum casing must never manufacture a mismatch.** All comparison is on normalized
  lowercase addresses; a false mismatch here would block real money.
- **Missing bytecode, missing ABI capability, or an inconsistent address is UNKNOWN or
  FAIL — never assumed safe.**

## Verified against production

Confirmed for AAPLx on X Layer on 2026-09-03:

```text
registry token          0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a
registry wrapper (v2)   0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f
wrapper.asset()      -> 0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a   ✓ matches
eth_getCode(token)   -> 0x6080…  (4278 chars)                        ✓ present
eth_getCode(wrapper) -> 0x6080…  (4278 chars)                        ✓ present
```

All six checks `PASS` for this asset at that block.

## Registry refresh and diffing

A refresh never silently overwrites what we previously believed. Each material difference
becomes a typed change, and the ones that matter open review evidence:

| Change                          | Opens review | Why                                                                                   |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------- |
| `DEPLOYMENT_ADDED`              | No           | A newly discovered asset is normal operation                                          |
| `WRAPPER_CHANGED`               | **Yes**      | Outstanding receipts were bound to the old wrapper                                    |
| `DEPLOYMENT_REMOVED`            | **Yes**      | Integrations may still be pointing at it                                              |
| `FIELD_CHANGED` (token address) | **Yes**      | The canonical address changing under us is a serious claim                            |
| `FIELD_CHANGED` (symbol)        | No           | Cosmetic                                                                              |
| `NO_CHANGE`                     | No           | Reported explicitly, so "checked and unchanged" is distinguishable from "not checked" |

Checksum casing alone is never reported as a change. Every change carries both the previous
and the current value, so history is preserved rather than replaced.
