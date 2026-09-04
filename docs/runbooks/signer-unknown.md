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
- **The response and receipt event commit atomically.** The idempotency row, exact response,
  `RECEIPT_ISSUED`, and receipt projection share one transaction.
- **`Idempotency-Key` binds the request body.** A retry with the same actor, key, and body
  returns the stored response; a different body is rejected — never a second receipt.

## Diagnose

```bash
# Did a receipt actually get issued for this request?
psql "$DATABASE_URL" -c "
  SELECT id, aggregate_id, observed_at, payload->>'receiptId' AS receipt_id
  FROM evidence_events
  WHERE event_type = 'RECEIPT_ISSUED' AND correlation_id = '<correlation-id>';"

# Is the signer configured at all?
curl -s "$GUARD_API_URL/v1/health/ready" | jq '.components[] | select(.name=="receipt-signer")'

# Inspect the durable command outcome without storing a signature in the journal.
psql "$DATABASE_URL" -c "
  SELECT actor_id, operation, idempotency_key, status, completed_at
  FROM idempotency_keys
  WHERE actor_id = '<principal>' AND operation = 'preflight'
    AND idempotency_key = '<original-key>';"
```

The correlation id is in the response headers of the original request and in the logs.

| Database shows                                 | Conclusion                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| Completed idempotency row and `RECEIPT_ISSUED` | The receipt exists; a same-body retry returns the exact response. |
| No idempotency row                             | The transaction did not commit; retry with the same key.          |

## Recover

1. Confirm the signer is reachable: `/v1/health/ready` reports the component.
2. Retry the original request **with the same idempotency key**. A different key is a new
   intent, and will mint a second receipt.
3. If the signer is down, protected actions stay blocked. That is the intended behaviour —
   there is no fail-open path, and adding one would defeat the product.

## Reproduce it deliberately

`FAULT_EXPECTATIONS` declares `SIGNER_TIMEOUT` and `SIGNER_UNKNOWN_OUTCOME`, but those
injections are not yet wired to the receipt signer. Treat them as pending acceptance
scenarios; do not claim the environment commands reproduce them today.

## The production gap, stated plainly

The signing key lives in process memory for the lifetime of a signature. Production
requires HSM/KMS custody or threshold signing plus an auditable rotation procedure
(ADR 0002). That is documented, not implemented, and no runbook step changes it.
