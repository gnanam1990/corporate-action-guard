# Deployment

## The credential boundary is the design

Three processes, three different sets of secrets. The separation is enforced by _what each
container is given_, not by discipline inside the application.

|            | Database URL | KMS sign access |  Mainnet RPC   | Public API URL |
| ---------- | :----------: | :-------------: | :------------: | :------------: |
| **api**    |      ✅      |       ✅        |       ✕        |       ✅       |
| **worker** |      ✅      |        ✕        | ✅ (read only) |       ✕        |
| **web**    |      ✕       |        ✕        |       ✕        |       ✅       |

The web container receives only two non-secret routing values: `API_INTERNAL_BASE_URL`
routes server-rendered reads over Docker DNS, while `NEXT_PUBLIC_API_BASE_URL` gives the
browser a host-reachable URL. That boundary is asserted mechanically:
`node scripts/check-compose-secrets.mjs` fails if either route drifts or any server secret
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
pnpm testnet:init
pnpm stack:up
```

Brings up PostgreSQL, a one-shot migration job, the API (4000), the worker, and the console
(3000). The API and worker start only after migrations succeed; the console waits for a
healthy API. Server-rendered console reads use `http://api:4000` inside the Compose network;
browser-side requests continue to use `http://localhost:4000`.

The local override explicitly sets `NODE_ENV=development` so the isolated local testnet
signer is accepted. The base full-stack file keeps `NODE_ENV=production` and therefore
fails closed unless AWS KMS is configured. `--env-file .env` is mandatory: Compose does not
implicitly load a repository-root `.env` when invoked from every working directory.

## Migrations are a release step, not a startup step

The API applies migrations automatically **only** when `NODE_ENV !== 'production'`. In
production, run them once as an explicit step:

```bash
docker run --rm -e DATABASE_URL="$DATABASE_URL" cag-api:latest packages/db/dist/cli.js
```

Running migrations on every replica start means N replicas racing the same DDL on every
deploy. Once, deliberately, before the new replicas roll.

## Chain configuration

| Variable                          | Given to            | Note                                             |
| --------------------------------- | ------------------- | ------------------------------------------------ |
| `XLAYER_MAINNET_RPC_URL`          | worker only         | **Read only.** Chain 196 is never written.       |
| `XLAYER_TESTNET_RPC_URL`          | deploy tooling      | The only chain this build writes to              |
| `RECEIPT_SIGNER_MODE`             | api only            | Production requires `aws-kms`                    |
| `AWS_KMS_KEY_ID`, `AWS_REGION`    | api only            | KMS reference; the private key never leaves KMS  |
| `RECEIPT_SIGNER_ADDRESS`          | api only            | Must match the KMS public key and adapter signer |
| `TESTNET_DEPLOYER_PRIVATE_KEY`    | deploy tooling only | Never in a long-running service                  |
| `INTEGRATOR_API_KEY_HASH`         | api only            | Bootstrap hash for key id `integ001`             |
| `OPERATOR_API_KEY_HASH`           | api only            | Bootstrap hash for key id `operator`             |
| `FIXTURE_API_KEY_HASH`            | api only            | Dedicated `admin:fixture` principal only         |
| `GUARD_ADAPTER_TESTNET_ADDRESS`   | api only            | Must name the current compatible adapter         |
| `PROTECTED_VAULT_TESTNET_ADDRESS` | api only            | The only target authorized by the API policy     |

The receipt signer, fixture-intent administrator, and testnet broadcaster are separate
roles. Do not combine them in production IAM or reuse their credentials.

Generate each API key independently. The command prints the raw value once for the client
secret manager and the SHA-256 value for the API environment:

```bash
pnpm api-key:generate integrator
pnpm api-key:generate operator
pnpm api-key:generate fixture
```

## AWS KMS receipt signer

Production configuration refuses `RECEIPT_SIGNER_PRIVATE_KEY`. Create an asymmetric KMS
key with `ECC_SECG_P256K1` / `SIGN_VERIFY`, then derive the Ethereum identity without
exporting a private key:

```bash
AWS_REGION=ap-south-1 AWS_KMS_KEY_ID=alias/cag-receipt-signer \
  pnpm signer:kms-address
```

Set the printed checksummed address as `RECEIPT_SIGNER_ADDRESS`, authorize that address on
the deployed adapter, and grant the API runtime only the policy in
[`runbooks/kms-signer.md`](runbooks/kms-signer.md). `/v1/health/ready` actively fetches the
public key and checks its type, usage, algorithm, and address; a configured alias alone is
not considered ready.

## Backup and restore

The append-only `evidence_events` journal is the source of truth. The archive includes the
whole database so schema, authentication, cursors, and projections return consistently;
projections remain reproducible from the journal.

```bash
# Refuses overwrite, verifies pg_restore can parse the archive, and writes SHA-256.
DATABASE_URL="$DATABASE_URL" BACKUP_PATH=/secure/guard.dump pnpm db:backup

# Creates, verifies, and always drops a disposable database. It never touches production.
DATABASE_ADMIN_URL="$DATABASE_ADMIN_URL" BACKUP_PATH=/secure/guard.dump \
  pnpm db:restore-drill
```

CI runs this exact archive-and-restore drill. Production must additionally encrypt and copy
the archive and checksum to versioned object storage, enable WAL/PITR according to the
platform's controls, set retention, and schedule recurring restore drills. Those are
deployment responsibilities and are not claimed by this repository.

## Monitoring and alerts

The API exposes Prometheus text at `/metrics`. `infra/monitoring/prometheus.yml` scrapes it,
and `infra/monitoring/alerts.yml` declares critical alerts for API/component readiness plus
a no-preflight-traffic warning. Validate and deploy those rules in the target monitoring
platform, route critical alerts to the on-call service, and test the route before launch.
Checked-in rules are configuration evidence, not evidence that anyone will be paged.

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

`/v1/health/live` and `/v1/health/ready` report process state. `/v1/system/version` exposes
the image's `GIT_SHA` and `BUILD_TIME`; absent build arguments are reported as `unknown`
rather than replaced with plausible-looking values.

## Never claim deployed until

1. HTTP checks pass against the real URL, from outside any developer's session.
2. Source freshness is current in `/v1/system/source-health`.
3. Chain bytecode is verified at every deployed address.
4. Testnet explorer links resolve.

A successful local build is not a production deployment.

The checked-in X Layer testnet artifact is current implementation v2 and is backed by the
proof package. This remains testnet evidence; the four external checks above still govern
any claim about a public production deployment.
