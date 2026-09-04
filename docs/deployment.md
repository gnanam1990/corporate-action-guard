# Deployment

## The credential boundary is the design

Three processes, three different sets of secrets. The separation is enforced by _what each
container is given_, not by discipline inside the application.

|            | Database URL | Signer key |  Mainnet RPC   | Public API URL |
| ---------- | :----------: | :--------: | :------------: | :------------: |
| **api**    |      ✅      |     ✅     |       ✕        |       ✅       |
| **worker** |      ✅      |     ✕      | ✅ (read only) |       ✕        |
| **web**    |      ✕       |     ✕      |       ✕        |       ✅       |

The web container receives **exactly one** variable and it is public by definition. That is
asserted mechanically: `node scripts/check-compose-secrets.mjs` fails if any server secret
name appears in the `web:` service block, and it is verified against a planted leak.

The worker holds the mainnet RPC because it reads chain state. It holds **no signing key**,
and there is no signing code path for chain 196 anywhere in the product.

## Images

Two images, deliberately:

- `infra/Dockerfile` — API and worker. One image, because they share every dependency and
  two nearly identical images is two things to keep patched. The entrypoint selects the
  process.
- `infra/Dockerfile.web` — the console. Separate for exactly one reason: it must never
  receive the signer key, the database URL, or an operator secret. Separate images make
  that a deployment fact rather than a review comment.

Both are multi-stage, run as a **non-root** user, and are compatible with a **read-only**
root filesystem (the applications never write to their own filesystem). Dev dependencies
are pruned from what ships.

**No secret is baked into an image.** Every credential arrives at runtime, so an image is
safe to push to a registry readable by more people than can read the database.

### A portability decision

The Dockerfiles do **not** use BuildKit cache mounts. They would speed rebuilds, but they
make the image unbuildable on a plain docker daemon — and a Dockerfile that cannot be built
is one whose correctness cannot be demonstrated. Speed lost, verifiability gained.

## Local full stack

```bash
docker compose -f infra/docker-compose.full.yml up --build
```

Brings up PostgreSQL, the API (4000), the worker, and the console (3000). The API waits for
a healthy database; the console waits for a healthy API.

## Migrations are a release step, not a startup step

The API applies migrations automatically **only** when `NODE_ENV !== 'production'`. In
production, run them once as an explicit step:

```bash
docker run --rm -e DATABASE_URL="$DATABASE_URL" cag-api:latest packages/db/dist/cli.js
```

Running migrations on every replica start means N replicas racing the same DDL on every
deploy. Once, deliberately, before the new replicas roll.

## Chain configuration

| Variable                       | Given to            | Note                                           |
| ------------------------------ | ------------------- | ---------------------------------------------- |
| `XLAYER_MAINNET_RPC_URL`       | worker only         | **Read only.** Chain 196 is never written.     |
| `XLAYER_TESTNET_RPC_URL`       | deploy tooling      | The only chain this build writes to            |
| `RECEIPT_SIGNER_PRIVATE_KEY`   | api only            | Separate identity from the testnet broadcaster |
| `TESTNET_DEPLOYER_PRIVATE_KEY` | deploy tooling only | Never in a long-running service                |

The receipt signer and the testnet broadcaster are **separate identities**, so compromising
the one that deploys does not grant the one that authorizes. `pnpm testnet:status` fails if
they are ever the same key.

## Backup and restore

Only one table must survive: `evidence_events`. Every projection is reproducible from it.

```bash
# Backup
pg_dump "$DATABASE_URL" --format=custom --file=guard-$(date -u +%Y%m%dT%H%M%SZ).dump

# Restore, then rebuild projections FROM the journal
pg_restore --dbname="$DATABASE_URL" --clean --if-exists guard-<timestamp>.dump
```

Projections are never restored independently of the journal: a projection row with no
journal row behind it is a fabricated claim.

## Rollback

The application is stateless; rolling back is redeploying the previous image tag.

**A migration is not automatically reversible.** Migrations here are additive by
convention, so an older application generally runs against a newer schema. If a rollback
crosses a destructive migration, restore from backup instead — and note that the journal's
append-only trigger means a "fix the data" rollback is not available by design.

## Zero downtime — stated honestly

This is a small-team build. It does **not** have zero-downtime deploys.

- The API is stateless and can roll, but nothing here orchestrates connection draining.
- The worker takes a durable lease; a new instance waits for the old lease to expire rather
  than running concurrently. That is correct, and it means a brief gap in observation.
- A gap in observation is safe: evidence ages, freshness limits are exceeded, and preflight
  **fails closed**. Users see refusals, not wrong answers.

Claiming zero downtime would be the easy sentence to write. It would also be the one an
operator discovers is untrue at the worst moment.

## Release provenance

`/v1/health/live` and `/v1/health/ready` report process state. Build metadata (git SHA,
build time) is **not yet** exposed by a version endpoint — recorded as a gap rather than
described as done.

## Never claim deployed until

1. HTTP checks pass against the real URL, from outside any developer's session.
2. Source freshness is current in `/v1/system/source-health`.
3. Chain bytecode is verified at every deployed address.
4. Testnet explorer links resolve.

A successful local build is not a production deployment.
