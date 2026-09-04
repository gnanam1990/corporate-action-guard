# Runbook — source outage

## Symptom

The degraded banner appears in the console, or preflight starts returning
`API_UNAVAILABLE` / `RPC_UNAVAILABLE`.

## What the system does on its own

Nothing dangerous. Every source failure fails **closed**: the guard refuses actions rather
than acting on evidence it could not obtain.

- A source that could not be reached produces `SOURCE_DEGRADED` in the journal. An empty
  catalog and an unreachable API are different facts and are recorded differently.
- The previous catalog projection is **not** overwritten by a failed walk. Last-known-good
  rows remain visible, labelled `STALE`.
- Stale data may be _displayed_. It may not _authorize_: past the freshness limit,
  preflight returns `STALE_API_EVIDENCE` or `STALE_CHAIN_EVIDENCE`.

## Diagnose

```bash
# What does the system think is unhealthy, and since when?
curl -s "$GUARD_API_URL/v1/system/source-health" | jq

# Is it us or them?
curl -sS -o /dev/null -w '%{http_code}\n' https://api.xstocks.fi/api/v2/public/assets?pageSize=1
curl -sS -X POST https://rpc.xlayer.tech -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

| Reading                                            | Meaning                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `eth_chainId` returns something other than `0x c4` | **Wrong chain.** Fix configuration. Never override the check.                                           |
| The API returns 429                                | Rate limited. The client already honours `Retry-After`; check for a second instance sharing the budget. |
| Both endpoints healthy but health still degraded   | The worker is not running, or its lease is held by a dead instance. Check `work_leases`.                |

## Recover

Recovery is **observed, not asserted**. A later successful observation appends
`SOURCE_RECOVERED`; there is no command that marks a source healthy, deliberately.

```bash
# Force one cycle now rather than waiting for the poll interval
node apps/worker/dist/index.js --once
```

## Reproduce it deliberately

```bash
FAULTS=XSTOCKS_TIMEOUT node apps/worker/dist/index.js --once
FAULTS=XSTOCKS_RATE_LIMITED,XSTOCKS_INVALID_PAYLOAD node apps/worker/dist/index.js --once
```

The xStocks faults are injected **at the I/O boundary**, so they travel the same path a
real failure would. `RPC_TIMEOUT` is declared in the fault catalog but is not yet wired to
the X Layer reader; do not claim that scenario has been reproduced end to end.

`FaultInjector` refuses to construct when `NODE_ENV=production`, and the check is on the
constructor, so a production process carrying a stray `FAULTS=` variable fails at startup
rather than misbehaving quietly under load.

Every fault declares what the system is required to do — state, evidence, operator view,
and recovery condition — in `FAULT_EXPECTATIONS`. A harness that only injects failures
proves nothing; the expectation is the test.

## What must never happen

|                                                          |                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| A receipt issued while a mandatory source is unavailable | There is no failure mode whose correct response is to authorize something |
| Stale rows shown without a `STALE` label                 | Displaying stale data is fine; presenting it as current is not            |
| A partial catalog replacing a complete one               | `INCOMPLETE_CATALOG` is raised instead                                    |
| A source marked healthy by hand                          | Recovery is observed, never asserted                                      |
