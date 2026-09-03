# xStocks production API

**Live verification date: 2026-09-03 (UTC).** Everything below was confirmed by real calls
to production on that date, not read from a planning document. Re-verify before release.

## Base URL — corrected

```text
https://api.xstocks.fi/api/v2
```

The prompt pack and the original `.env.example` template used `https://api.xstocks.fi`.
That host alone returns **404**; the `/api/v2` path segment is required. `.env.example` now
carries the corrected value.

OpenAPI document: `https://docs.xstocks.fi/_bundle/apis/@v2/openapi.json`
(OpenAPI 3.0.0, `info.version` 2.0.0). Staging and development servers exist and are not
used.

## Endpoints this product depends on

| Endpoint                                 | Used for                                             |
| ---------------------------------------- | ---------------------------------------------------- |
| `GET /public/assets`                     | Paginated catalog discovery, filterable by `network` |
| `GET /public/assets/{symbol}`            | Single-asset lookup with all chain deployments       |
| `GET /public/assets/{symbol}/multiplier` | Current and pending multiplier for a network         |
| `GET /public/corporate-actions/upcoming` | Scheduled corporate actions                          |

`network=XLayer` is the filter value for X Layer.

## Four findings that changed the implementation

### 1. The API publishes no multiplier nonce

The verified response is exactly:

```json
{
  "currentMultiplier": 1.0032690125398187,
  "newMultiplier": 0,
  "activationDateTime": 0,
  "reason": null
}
```

There is no nonce, epoch, or version field anywhere in the multiplier contract. Under the
original reading of "required sources agree", the nonce would be `INCOMPLETE` forever and
the guard would block every action permanently.

Resolved by **[ADR 0004](../architecture/decisions/0004-source-agreement-field-policy.md)**:
agreement is scored over fields both sources are contractually expected to expose. The
nonce is chain-authoritative and is instead checked directly against the caller's operation
and re-verified on chain by the adapter — a stronger check than two observers concurring.

A live contract test asserts the nonce is _still_ absent, so if xStocks starts publishing
one, the test fails and the field can be promoted into the required set.

### 2. `0` is a sentinel, not an instant

`newMultiplier: 0` and `activationDateTime: 0` mean "no pending corporate action". Reading
`activationDateTime: 0` as an epoch would place **every asset permanently inside a guard
window around 1970-01-01**, blocking the entire product. The client maps `0` to
`undefined`; a unit test pins that behaviour.

### 3. The multiplier arrives as a JSON number, and `JSON.parse` destroys it

`1.0032690125398187` is 17 significant digits — at the edge of double precision. By the
time a parsed object exists, the exact decimal the server sent is gone.

The client therefore extracts the multiplier's **literal digits from the raw response
body** and carries it as a fixed-point value (`exact-number.ts`). The parsed object is
still used for structure and every other field. A test proves two literals that are
distinguishable as exact decimals are identical as doubles.

`GET /public/corporate-actions/upcoming` returns `multiplierOld`/`multiplierNew` as
**strings**, which are exact already — preferred where available.

### 4. The catalog is multi-chain, and strict validation broke discovery

AAPLx has 11 deployments including Solana, Tron, and Ton, whose addresses are not
0x-prefixed:

```text
Solana  XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp
Tron    TZ7nsyCuQq1cusCtex6V4qbzWcb3NbibAM
Ton     EQDsjAwfKo-6FVZv2EYt-1CaZTY_ZL-pfkSId6jeQchNwmdo
```

Requiring EVM address format on every deployment rejected the whole asset — a strict check
on chains this product never reads turning into a **total discovery failure** against live
production. Address format is now validated per network family: strictly for EVM networks,
structurally for the rest. Regression tests cover both directions.

Note also that the same token address appears on many EVM chains, so an address alone does
not identify a chain. Chain identity always comes from the deployment's `network`.

## Pagination

The envelope carries only `currentPage` and `hasNextPage`:

```json
{"page":{"currentPage":0,"hasNextPage":true}, "nodes":[...]}
```

There is **no total count**, so the catalog size cannot be known before walking every page.
A first page returning 100 assets is not evidence the catalog holds 100 assets. The client
follows `hasNextPage` to completion and raises `INCOMPLETE_CATALOG` if it hits the page cap
or the time budget, rather than returning a partial list that would look complete.

Repeated page indices raise `PAGINATION_LOOP` — a server always reporting `currentPage: 0`
with `hasNextPage: true` would otherwise spin until the process died.

## Call limits and timeouts

| Setting             | Default                                 | Note                                                       |
| ------------------- | --------------------------------------- | ---------------------------------------------------------- |
| Per-request timeout | 10 s                                    |                                                            |
| Catalog walk budget | 60 s                                    | Exceeding it is `INCOMPLETE_CATALOG`, not a partial result |
| Retries             | 3                                       | GET only                                                   |
| Backoff             | exponential, full jitter, capped at 8 s | Prevents a worker fleet retrying in lockstep               |
| `Retry-After`       | honoured, capped at 30 s                | Takes precedence over the backoff curve                    |
| Page cap            | 100                                     |                                                            |
| Response cap        | 8 MiB                                   | Checked on `content-length` and on the actual body         |
| `pageSize`          | 100 (API maximum)                       |                                                            |

**Retryability is decided where an error is created, never inferred from its kind later.** A
schema violation and a truncated body are both `INVALID_PAYLOAD`, but only the truncated
body is worth retrying — the server answering incorrectly will keep answering incorrectly.
A 4xx other than 408/425/429 is never retried. Getting this wrong once caused a 400 to be
retried four times; a test now pins the attempt count.

## Failure model

| Kind                 | Meaning                                  | Retried                      |
| -------------------- | ---------------------------------------- | ---------------------------- |
| `UNAVAILABLE`        | Transport failure or non-OK status       | Only 408/425/429/5xx         |
| `TIMEOUT`            | Request exceeded the per-request timeout | Yes                          |
| `RATE_LIMITED`       | 429                                      | Yes, honouring `Retry-After` |
| `INVALID_PAYLOAD`    | Truncated body, or schema violation      | Body yes, schema no          |
| `PAGINATION_LOOP`    | A page index was seen twice              | No                           |
| `INCOMPLETE_CATALOG` | Page cap or time budget hit mid-walk     | No                           |
| `RESPONSE_TOO_LARGE` | Body exceeded the cap                    | No                           |
| `NOT_FOUND`          | 404                                      | No                           |

**There is no fallback path.** Bundled sample data is never substituted when a production
call fails; a test asserts the only outcome is a typed error. Last-known-good data may be
_displayed_ with a `STALE` label, but cannot authorize a protected action past its
freshness limit (ADR 0003).

## Evidence freshness

Every result carries a redacted `sourceLocator` and the raw body. `redactUrl` strips
userinfo and credential-shaped query parameters before a URL can reach a log or the
journal, and never throws on unparseable input.

## Running the live contract test

```bash
XSTOCKS_LIVE_CONTRACT_TEST=1 pnpm test:integration
```

Opt-in only — ordinary CI stays deterministic, and a third-party endpoint is not a
dependency a required check should have. Last run 2026-09-03: **4 passed**.

The AAPLx assertions are a point-in-time smoke check that a verified call happened. They
are not a permanent registry: canonical addresses always come from the live API at runtime,
never from a constant in source (ADR 0002).

Observed on 2026-09-03 for AAPLx on X Layer:

| Field                                | Value                                        |
| ------------------------------------ | -------------------------------------------- |
| Token                                | `0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a` |
| Current wrapper (`wrapperAddressV2`) | `0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f` |
| `wrapperAddress` (v1)                | absent                                       |
| `currentMultiplier`                  | `1.0032690125398187`                         |
| Pending action                       | none (`0` sentinels)                         |
