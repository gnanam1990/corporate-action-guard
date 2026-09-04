#
# Multi-stage build for the API and the worker.
#
# One image serves both: they share every dependency, and two nearly identical images is
# two things to keep patched. The entrypoint selects which process runs.

# --- deps -------------------------------------------------------------------
# Pinned by digest, so a rebuild produces the same base rather than whatever :22-alpine
# points at today. Update deliberately; see docs/deployment.md.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS deps
WORKDIR /app

RUN corepack enable

# Copy only what the dependency graph needs, so a source change does not bust this layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json           apps/api/
COPY apps/worker/package.json        apps/worker/
COPY apps/web/package.json           apps/web/
COPY packages/config/package.json    packages/config/
COPY packages/domain/package.json    packages/domain/
COPY packages/db/package.json        packages/db/
COPY packages/observability/package.json packages/observability/
COPY packages/xstocks-client/package.json packages/xstocks-client/
COPY packages/xlayer-reader/package.json  packages/xlayer-reader/
COPY packages/receipts/package.json  packages/receipts/
COPY packages/reconciler/package.json packages/reconciler/
COPY packages/sdk/package.json       packages/sdk/

# No BuildKit cache mount: it makes the image unbuildable on a plain docker daemon, and
# an unbuildable Dockerfile is one whose correctness cannot be demonstrated.
RUN pnpm install --frozen-lockfile --ignore-scripts

# --- build ------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/
COPY apps/worker/ apps/worker/
RUN pnpm exec tsc --build

# NOT `pnpm prune --prod`.
#
# In a workspace, prune empties each package's own node_modules — including the relative
# symlinks that resolve @cag/* — and the container then dies at startup with
# ERR_MODULE_NOT_FOUND. A production install in the runtime stage relinks them correctly
# and drops dev dependencies at the same time.

# --- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# Build provenance, surfaced by /v1/system/version. Absent values report "unknown"
# rather than a plausible-but-wrong SHA, which would send an investigation to the
# wrong code.
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV GIT_SHA=${GIT_SHA}
ENV BUILD_TIME=${BUILD_TIME}

ENV NODE_ENV=production
# Fault injection refuses to construct in production, but say so in the image too: a
# reader should not have to infer it from code.
ENV FAULTS=""

# Non-root. The application never writes to its own filesystem, so the container can run
# read-only; see the compose file and the deployment manifest.
RUN addgroup -S guard && adduser -S -G guard guard

RUN corepack enable

# Manifests and lockfile first, so a source change does not re-resolve the graph.
COPY --chown=guard:guard package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=guard:guard apps/api/package.json    apps/api/
COPY --chown=guard:guard apps/worker/package.json apps/worker/
COPY --chown=guard:guard packages/config/package.json         packages/config/
COPY --chown=guard:guard packages/domain/package.json         packages/domain/
COPY --chown=guard:guard packages/db/package.json             packages/db/
COPY --chown=guard:guard packages/observability/package.json  packages/observability/
COPY --chown=guard:guard packages/xstocks-client/package.json packages/xstocks-client/
COPY --chown=guard:guard packages/xlayer-reader/package.json  packages/xlayer-reader/
COPY --chown=guard:guard packages/receipts/package.json       packages/receipts/
COPY --chown=guard:guard packages/reconciler/package.json     packages/reconciler/

# Production dependencies only. This is what creates the per-package node_modules symlinks
# that resolve @cag/* — the thing `pnpm prune` destroys.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Compiled output and the SQL migrations. No TypeScript sources ship.
COPY --from=build --chown=guard:guard /app/packages/config/dist          packages/config/dist
COPY --from=build --chown=guard:guard /app/packages/domain/dist          packages/domain/dist
COPY --from=build --chown=guard:guard /app/packages/db/dist              packages/db/dist
COPY --from=build --chown=guard:guard /app/packages/db/migrations        packages/db/migrations
COPY --from=build --chown=guard:guard /app/packages/observability/dist   packages/observability/dist
COPY --from=build --chown=guard:guard /app/packages/xstocks-client/dist  packages/xstocks-client/dist
COPY --from=build --chown=guard:guard /app/packages/xlayer-reader/dist   packages/xlayer-reader/dist
COPY --from=build --chown=guard:guard /app/packages/receipts/dist        packages/receipts/dist
COPY --from=build --chown=guard:guard /app/packages/receipts/vectors     packages/receipts/vectors
COPY --from=build --chown=guard:guard /app/packages/reconciler/dist      packages/reconciler/dist
COPY --from=build --chown=guard:guard /app/apps/api/dist                 apps/api/dist
COPY --from=build --chown=guard:guard /app/apps/worker/dist              apps/worker/dist

USER guard

# No secret is baked in. Every credential arrives at runtime, so the image is safe to push
# to a registry that more people can read than can read the database.
# tini would be preferable for signal handling; both processes install their own SIGTERM
# handler and shut down gracefully, so node's default is adequate here.
ENTRYPOINT ["node"]
CMD ["apps/api/dist/index.js"]
