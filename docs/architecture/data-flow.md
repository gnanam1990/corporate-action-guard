# Data flow

Six traced flows. Each names its inputs, its durable evidence, and its fail direction.

## 1. Asset discovery

```mermaid
sequenceDiagram
  participant W as Worker
  participant X as xStocks API
  participant DB as Journal
  W->>X: GET paginated catalog (cursor)
  X-->>W: page (validated at ingress)
  Note over W: repeat until hasNextPage=false or page cap
  W->>DB: append ASSET_DISCOVERED / API_SNAPSHOT_OBSERVED
  W->>DB: update current_assets projection (same transaction)
```

Fail direction: a truncated or looping pagination run raises `incomplete-catalog` and does
**not** overwrite the previous catalog projection. The first page returning 100 assets is
never treated as proof the catalog holds only 100 assets.

## 2. Chain observation

```mermaid
sequenceDiagram
  participant W as Worker
  participant R as X Layer RPC (196)
  participant DB as Journal
  W->>R: eth_chainId
  R-->>W: 196 (else abort: wrong chain)
  W->>R: eth_getCode(token), eth_getCode(wrapper)
  Note over W: 0x code blocks canonical verification
  W->>R: multicall: wrapper.asset(), multiplier, nonce, activation
  R-->>W: results + block number and hash
  W->>DB: append CHAIN_SNAPSHOT_OBSERVED (block-stamped)
  W->>R: eth_getLogs(from cursor, adaptive range)
  W->>DB: append log events (unique on chain_id+tx_hash+log_index)
  W->>DB: advance indexed_chain_cursor
```

`latest` is never used without recording the block that was returned. If a stored block
hash no longer matches, `REORG_DETECTED` is appended, the cursor rewinds to a safe block,
and affected projections are rebuilt. History is never erased.

## 3. Reconciliation and projection rebuild

```text
inputs   immutable API observations
       + immutable chain observations
       + canonicality records
       + now (supplied by caller, never Date.now() inside domain)
       + freshness and guard-window policy
         |
         v
  compareSources(api, chain, tolerance)  -->  MATCH | MISMATCH | INCOMPLETE
  deriveLifecycleState(input, now)       -->  NORMAL | PENDING | GUARD_WINDOW
                                              | APPLIED | RECONCILED
         |
         v
outputs  domain transitions + evidence events
         (the reconciler never writes UI projections directly and never signs)
```

`MISMATCH` escalates to `MANUAL_REVIEW` and can only reach `RECOVERED` when a later
*complete* observation agrees. An operator resolution records actor, reason, evidence, and
policy version — it cannot fabricate source agreement, and protected actions stay blocked
while evidence still disagrees.

## 4. Preflight request → receipt issuance

```mermaid
sequenceDiagram
  participant I as Integrator
  participant A as API
  participant D as domain
  participant S as Signer
  participant DB as Journal
  I->>A: POST /v1/preflight (+ API key, idempotency key)
  A->>DB: load current evidence + canonicality
  A->>D: evaluatePreflight(input)
  D-->>A: ALLOW (0 reasons) | BLOCK (>=1 stable reason codes)
  alt BLOCK
    A->>DB: append ACTION_REJECTED
    A-->>I: BLOCK + reason codes + evidence IDs, NO receipt
  else ALLOW
    A->>S: sign(operationDigest) after transactional re-verification
    S-->>A: EIP-712 signature (or timeout -> UNKNOWN, no placeholder)
    A->>DB: append RECEIPT_ISSUED (journaled before responding)
    A-->>I: ALLOW + receipt + digest + validity window
  end
```

A receipt is never returned for `UNKNOWN` or degraded mandatory evidence.

## 5. Testnet receipt consumption

```mermaid
sequenceDiagram
  participant I as Integrator wallet
  participant AD as ActionGuardAdapter (1952)
  participant FX as Fixture wrapper
  participant V as ProtectedVault
  I->>AD: execute(operation, receipt, signature)
  AD->>AD: chain, adapter, caller, target, asset, wrapper, action, recipient, amount match digest
  AD->>FX: wrapper.asset() == expected asset?
  AD->>FX: current multiplier nonce == receipt.expectedNonce?
  AD->>AD: block.timestamp outside inclusive guard window?
  AD->>AD: signer authorized? within validAfter..validUntil? not consumed?
  AD->>AD: mark consumed BEFORE any external call
  AD->>V: perform protected action
  AD-->>I: event, or revert with custom error
```

Any failed check reverts. No protected state change survives a failed guard.

## 6. Incident replay

```text
select incident -> choose evidence cutoff + policy version
  -> load immutable events up to cutoff (no live source calls)
  -> re-run the same pure domain functions
  -> compare replayed decision with the recorded decision
  -> export JSON/CSV evidence bundle (secret fields excluded)
```

Replay that calls a live source is not a replay. The policy and code version used are
always displayed with the result.
