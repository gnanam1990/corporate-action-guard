# Development

## Prerequisites

| Tool            | Version            | Pinned by                        |
| --------------- | ------------------ | -------------------------------- |
| Node.js         | 22.23.1 (>= 22.11) | `.nvmrc`, `engines.node`         |
| pnpm            | 11.10.0 (>= 10)    | `packageManager`, `engines.pnpm` |
| Foundry (forge) | 1.7.1              | install via `foundryup`          |
| Docker          | any recent engine  | `infra/docker-compose.yml`       |

The repository uses a git submodule for `forge-std`. Clone with:

```bash
git clone --recurse-submodules https://github.com/gnanam1990/corporate-action-guard.git
# already cloned?
git submodule update --init --recursive
```

## First run (macOS and Linux)

```bash
pnpm install --frozen-lockfile
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate
pnpm verify
```

`pnpm verify` runs, in order: `format:check`, `lint`, `arch:check`, `typecheck`, `test`.

## Ports

| Service     | Port      | Notes                                                                                                                                 |
| ----------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL  | **55432** | Host port deliberately not 5432 — a native PostgreSQL install commonly owns that port and silently wins over the container's forward. |
| API         | 4000      | Derived from `API_PUBLIC_BASE_URL`                                                                                                    |
| Web console | 3000      |                                                                                                                                       |

## Workspace scripts

| Command                                        | What it does                                    |
| ---------------------------------------------- | ----------------------------------------------- |
| `pnpm lint` / `pnpm lint:fix`                  | ESLint across the workspace                     |
| `pnpm format` / `pnpm format:check`            | Prettier, including Solidity                    |
| `pnpm typecheck`                               | `tsc --build` across all project references     |
| `pnpm test`                                    | Vitest `unit` project                           |
| `pnpm test:integration`                        | Vitest `integration` project (needs PostgreSQL) |
| `pnpm build`                                   | Builds every package, then every app            |
| `pnpm dev`                                     | Runs every app's dev server in parallel         |
| `pnpm db:migrate`                              | Applies pending SQL migrations                  |
| `pnpm arch:check`                              | Enforces the layer dependency rule              |
| `pnpm build:contracts` / `pnpm test:contracts` | Foundry build and test                          |
| `pnpm infra:up` / `pnpm infra:down`            | PostgreSQL lifecycle                            |

## Architecture dependency rule

`scripts/check-layering.mjs` enforces the layer table in
`docs/architecture/component-map.md`. A package may import only from a **strictly lower**
layer, nothing may import an app, and `@cag/domain`, `@cag/config`, `@cag/sdk`, and
`@cag/web` may not import any workspace package at all. The check reads both declared
dependencies and actual import specifiers, so a deep path import cannot bypass it.

## Secret boundary

Two mechanical checks, not conventions:

1. `packages/config` refuses to start if any `NEXT_PUBLIC_`-prefixed variable is not on
   the explicit public allowlist, and asserts that no declared server secret carries that
   prefix.
2. `node scripts/scan-web-bundle.mjs`, run after the production web build, fails if a
   server env **name** or a secret-shaped **value** (hex private key, postgres URL, bearer
   token) appears in a client asset. Its own negative test plants a canary and confirms
   the scan fails.

## Migrations

Migrations are plain SQL in `packages/db/migrations`, applied in filename order, each in
its own transaction, recorded in `schema_migrations` with a SHA-256 of the file. Editing
an already-applied migration is a hard error — add a new file instead.

## Toolchain note: TypeScript version

TypeScript is pinned to **6.0.3**, not the latest 7.0.x. `typescript-eslint@8` refuses to
load against the TypeScript 7 API, so lint is impossible on 7.0. Revisit when
typescript-eslint ships TS 7 support (typescript-eslint#10940).

## What is not runnable yet

See `docs/build-readiness.md`. At the foundation stage the API and worker expose process
and database reachability only, and the web app renders no product data.
