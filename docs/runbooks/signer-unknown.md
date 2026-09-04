# Runbook — signer timeout or unknown outcome

## The situation

A preflight reached the signing step and the signer did not answer in time. You do not know
whether it signed.

This is the one failure where "assume it worked" and "assume it didn't" are **both** wrong.
Assuming success returns a receipt that may not exist; assuming failure and retrying
without care mints a second receipt for one intent.

## What the system does

- **No placeholder signature is ever returned.** The request fails with a typed
  `SIGNER_UNAVAILABLE`. A placeholder would be indistinguishable from a real receipt to a
  caller that did not verify.
- **A receipt is journalled before the response is returned.** If `RECEIPT_ISSUED` is
  absent from the journal, no receipt was issued, regardless of what the signer did
  internally.
- **`Idempotency-Key` is mandatory on preflight.** A retry with the same key resolves to
  the same receipt or to none — never to a second one.

## Diagnose

```bash
# Did a receipt actually get issued for this request?
psql "$DATABASE_URL" -c "
  SELECT id, aggregate_id, observed_at, payload->>'receiptId' AS receipt_id
  FROM evidence_events
  WHERE event_type = 'RECEIPT_ISSUED' AND correlation_id = '<correlation-id>';"

# Is the signer configured at all?
curl -s "$GUARD_API_URL/v1/health/ready" | jq '.components[] | select(.name=="receipt-signer")'
```

The correlation id is in the response headers of the original request and in the logs.

| Journal shows          | Conclusion                                                             |
| ---------------------- | ---------------------------------------------------------------------- |
| A `RECEIPT_ISSUED` row | The receipt exists. Retrying with the same idempotency key returns it. |
| No row                 | No receipt was issued. Safe to retry.                                  |

## Recover

1. Confirm the signer is reachable: `/v1/health/ready` reports the component.
2. Retry the original request **with the same idempotency key**. A different key is a new
   intent, and will mint a second receipt.
3. If the signer is down, protected actions stay blocked. That is the intended behaviour —
   there is no fail-open path, and adding one would defeat the product.

## Reproduce it deliberately

```bash
FAULTS=SIGNER_TIMEOUT           pnpm test:integration
FAULTS=SIGNER_UNKNOWN_OUTCOME   pnpm test:integration
```

## The production gap, stated plainly

The signing key lives in process memory for the lifetime of a signature. Production
requires HSM/KMS custody or threshold signing plus an auditable rotation procedure
(ADR 0002). That is documented, not implemented, and no runbook step changes it.
