import { randomUUID } from 'node:crypto';
import {
  appendEvidence,
  applyEventToProjections,
  checkDatabase,
  claimIdempotentCommand,
  completeIdempotentCommand,
  coverageSummary,
  getAsset,
  listAssets,
  listIncidents,
  replayAsset,
  sourceHealth,
  payloadHash,
  withTransaction,
} from '@cag/db';
import { createLogger, type Logger } from '@cag/observability';
import type { ReceiptSigner } from '@cag/receipts';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { authenticate, hasScope, type ApiKeyRecord, type Scope } from './auth.js';
import { problem, type ProblemDetails } from './problem.js';
import { API_VERSION } from './openapi.js';
import { runPreflight, type EvidenceBundle, type PreflightPolicy } from './preflight-service.js';
import {
  assetFilterSchema,
  idempotencyKeySchema,
  incidentFilterSchema,
  preflightRequestSchema,
  reviewResolutionSchema,
  timelineQuerySchema,
} from './schemas.js';
import type { Pool } from 'pg';

export interface ServerDeps {
  readonly db: Pool;
  readonly databaseUrl: string;
  readonly signer: ReceiptSigner;
  readonly policy: PreflightPolicy;
  readonly lookupApiKey: (
    keyId: string,
  ) => ApiKeyRecord | undefined | Promise<ApiKeyRecord | undefined>;
  /** Assembles the evidence a preflight decision rests on. */
  readonly loadEvidence: (assetId: string) => Promise<EvidenceBundle>;
  readonly corsOrigins: readonly string[];
  readonly logger?: Logger;
  /** Supplied so tests control time rather than racing it. */
  readonly now?: () => number;
}

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    principal?: { id: string; keyId: string; scopes: readonly Scope[] };
  }
}

const send = (reply: FastifyReply, details: ProblemDetails): FastifyReply =>
  reply.code(details.status).type('application/problem+json').send(details);

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const now = deps.now ?? Date.now;
  const logger =
    deps.logger ??
    createLogger({
      service: 'api',
      level: process.env['LOG_LEVEL'] === 'debug' ? 'debug' : 'info',
    });

  const app = Fastify({
    // Fastify's own logger is off entirely: request logging goes through
    // @cag/observability, which applies central redaction. Fastify would emit headers
    // unredacted, and the Authorization and x-api-key headers are exactly what must not
    // reach a log line.
    logger: false,
    // Bounded so a large body cannot be used to exhaust memory before validation runs.
    bodyLimit: 256 * 1024,
    requestTimeout: 20_000,
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });

  await app.register(cors, {
    // Allowlist from configuration. Never a wildcard with credentials.
    origin: (origin, cb) => {
      if (origin === undefined || deps.corsOrigins.includes(origin)) cb(null, true);
      else cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['content-type', 'x-api-key', 'idempotency-key'],
  });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // Per principal where authenticated, per IP otherwise, so one integrator's traffic
    // cannot exhaust another's budget.
    keyGenerator: (request: FastifyRequest) => request.principal?.id ?? request.ip,
    errorResponseBuilder: () =>
      problem.tooManyRequests('Rate limit exceeded. Retry after the window.'),
  });

  /** Correlation id on every request, propagated to logs, journal, and error bodies. */
  app.addHook('onRequest', async (request, reply) => {
    const supplied = request.headers['x-correlation-id'];
    request.correlationId =
      typeof supplied === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(supplied)
        ? supplied
        : randomUUID();
    void reply.header('x-correlation-id', request.correlationId);
  });

  app.setErrorHandler((error, request, reply) => {
    // The client gets a correlation id and nothing else. The detail goes to the log, where
    // it is redacted on the way out.
    logger.error('unhandled request error', {
      correlationId: request.correlationId,
      route: request.routeOptions.url ?? request.url,
      error: error instanceof Error ? error.message : String(error),
    });
    return send(reply, problem.internal(request.correlationId));
  });

  app.setNotFoundHandler((request, reply) => send(reply, problem.notFound('No such route.')));

  /** Require a scope, or reject. */
  const requireScope = (scope: Scope) => async (request: FastifyRequest, reply: FastifyReply) => {
    const raw = request.headers['x-api-key'];
    const result = await authenticate(typeof raw === 'string' ? raw : undefined, deps.lookupApiKey);

    if (!result.ok) {
      logger.warn('authentication rejected', {
        correlationId: request.correlationId,
        reason: result.reason,
      });
      // Every failure reason returns the same 401 body: distinguishing them would tell an
      // attacker whether a key id exists.
      return send(reply, problem.unauthorized());
    }
    if (!hasScope(result.scopes, scope)) {
      return send(reply, problem.forbidden(`This key lacks the ${scope} scope.`));
    }
    request.principal = { id: result.principal, keyId: result.keyId, scopes: result.scopes };
    return undefined;
  };

  // --- Health -------------------------------------------------------------

  app.get('/v1/health/live', async () => ({
    status: 'live' as const,
    uptimeSeconds: Math.floor(process.uptime()),
  }));

  /**
   * Build provenance.
   *
   * Every claim about "the deployed version" needs something to point at. Values come from
   * build-time environment; when absent the endpoint reports `unknown` rather than
   * inventing a plausible SHA. A wrong commit hash is worse than none — it sends an
   * investigation to the wrong code.
   */
  app.get('/v1/system/version', async () => ({
    gitSha: process.env['GIT_SHA'] ?? 'unknown',
    buildTime: process.env['BUILD_TIME'] ?? 'unknown',
    nodeVersion: process.version,
    apiContractVersion: API_VERSION,
    // Stated in the response, so a reader of the API alone learns the boundary.
    enforcementBoundary:
      'Enforceable only for paths routing through ActionGuardAdapter. A direct ERC-20 transfer bypasses the guard. X Layer mainnet is read-only.',
  }));

  app.get('/v1/health/ready', async (_request, reply) => {
    const database = await checkDatabase(deps.databaseUrl);
    const signerAddress = deps.signer.address();
    const components = [
      { name: 'database', ok: database.ok, detail: database.detail },
      {
        name: 'receipt-signer',
        ok: signerAddress !== undefined,
        // The address is public. The key is never read here.
        detail:
          signerAddress === undefined ? 'no signing key configured' : `signer ${signerAddress}`,
      },
      {
        name: 'guard-adapter',
        ok: deps.policy.verifyingContract !== '0x0000000000000000000000000000000000000000',
        detail:
          deps.policy.verifyingContract === '0x0000000000000000000000000000000000000000'
            ? 'no compatible adapter configured'
            : `adapter ${deps.policy.verifyingContract}`,
      },
      {
        name: 'protected-target',
        ok: deps.policy.supportedTargets.length > 0,
        detail:
          deps.policy.supportedTargets.length === 0
            ? 'no protected target configured'
            : `${deps.policy.supportedTargets.length} target(s) configured`,
      },
    ];
    const ready = components.every((c) => c.ok);
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? 'ready' : 'not-ready', components });
  });

  // --- Public evidence reads ----------------------------------------------

  app.get('/v1/assets', async (request, reply) => {
    const parsed = assetFilterSchema.safeParse(request.query);
    if (!parsed.success) {
      return send(
        reply,
        problem.badRequest(
          'Invalid query parameters.',
          parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        ),
      );
    }

    const page = await listAssets(deps.db, {
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
      lifecycleState: parsed.data.lifecycleState,
      canonicality: parsed.data.canonicality,
      search: parsed.data.search,
      staleEvidence: parsed.data.staleEvidence,
      apiStaleBefore: new Date(now() - deps.policy.apiMaxAgeMs),
      chainStaleBefore: new Date(now() - deps.policy.chainMaxAgeMs),
    });

    return {
      items: page.items.map(serializeAsset),
      nextCursor: page.nextCursor ?? null,
      // Freshness travels with the data, so a client can never render it as current
      // without also having the means to see that it is not.
      servedAt: new Date(now()).toISOString(),
    };
  });

  app.get('/v1/assets/:assetId', async (request, reply) => {
    const { assetId } = request.params as { assetId: string };
    const asset = await getAsset(deps.db, assetId);
    if (asset === undefined) return send(reply, problem.notFound(`No asset ${assetId}.`));
    return { ...serializeAsset(asset), servedAt: new Date(now()).toISOString() };
  });

  app.get('/v1/system/coverage', async () => ({
    ...(await coverageSummary(deps.db)),
    servedAt: new Date(now()).toISOString(),
  }));

  app.get('/v1/system/source-health', async () => {
    const rows = await sourceHealth(deps.db);
    return {
      sources: rows.map((r) => ({
        sourceKind: r.sourceKind,
        healthy: r.healthy,
        lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
        lastFailureAt: r.lastFailureAt?.toISOString() ?? null,
        detail: r.detail,
      })),
      servedAt: new Date(now()).toISOString(),
    };
  });

  app.get('/v1/incidents', async (request, reply) => {
    const parsed = incidentFilterSchema.safeParse(request.query);
    if (!parsed.success) {
      return send(
        reply,
        problem.badRequest(
          'Invalid query parameters.',
          parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        ),
      );
    }
    const rows = await listIncidents(deps.db, {
      status: parsed.data.status,
      assetId: parsed.data.assetId,
      limit: parsed.data.limit,
    });
    return {
      items: rows.map((r) => ({
        incidentId: r.incidentId,
        assetId: r.assetId,
        severity: r.severity,
        status: r.status,
        reasonCodes: r.reasonCodes,
        firstDetectedAt: r.firstDetectedAt.toISOString(),
        lastObservedAt: r.lastObservedAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
      })),
      servedAt: new Date(now()).toISOString(),
    };
  });

  /**
   * The evidence timeline for one asset, and its deterministic replay.
   *
   * Replay reads immutable journal rows only. It never calls a live source — a "replay"
   * that does is a fresh observation wearing a historical label.
   */
  app.get('/v1/assets/:assetId/timeline', async (request, reply) => {
    const { assetId } = request.params as { assetId: string };
    const query = timelineQuerySchema.safeParse(request.query);
    if (!query.success) {
      return send(
        reply,
        problem.badRequest(
          'Invalid timeline query parameters.',
          query.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        ),
      );
    }

    const asset = await getAsset(deps.db, assetId);
    if (asset === undefined) return send(reply, problem.notFound(`No asset ${assetId}.`));

    const replay = await replayAsset(deps.db, assetId, {
      upToEventId: query.data.upToEventId,
      limit: query.data.limit,
    });

    return {
      ...replay,
      // Surfaced, not hidden: a replay spanning a code change may have been produced by
      // logic that no longer exists.
      policyNote: replay.singleProducerVersion
        ? 'All events in this range were produced by one code version.'
        : 'This range spans more than one producer version; the original decision may have been produced by logic that no longer exists.',
      servedAt: new Date(now()).toISOString(),
    };
  });

  // --- Integrator: preflight ----------------------------------------------

  app.post(
    '/v1/preflight',
    { preHandler: requireScope('integrator:preflight') },
    async (request, reply) => {
      const idempotencyHeader = request.headers['idempotency-key'];
      const idempotency = idempotencyKeySchema.safeParse(idempotencyHeader);
      if (!idempotency.success) {
        // Mandatory: a retried preflight must not mint a second receipt for the same intent.
        return send(
          reply,
          problem.badRequest('An Idempotency-Key header is required for preflight.'),
        );
      }

      const parsed = preflightRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return send(
          reply,
          problem.badRequest(
            'Invalid preflight request.',
            parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          ),
        );
      }

      const principal = request.principal;
      if (principal === undefined) return send(reply, problem.unauthorized());

      const commandKey = idempotency.data;
      const requestHash = payloadHash(parsed.data);
      const outcome = await withTransaction(deps.db, async (client) => {
        const claim = await claimIdempotentCommand<Awaited<ReturnType<typeof runPreflight>>>(
          client,
          {
            actorId: principal.id,
            operation: 'preflight',
            key: commandKey,
            requestHash,
          },
        );
        if (claim.kind !== 'CLAIMED') return claim;

        const evaluatedAt = now();
        const evidence = await deps.loadEvidence(parsed.data.assetId);
        const response = await runPreflight(parsed.data, evidence, {
          signer: deps.signer,
          policy: deps.policy,
          nowMs: evaluatedAt,
          requestId: request.correlationId,
          receiptId: `0x${randomUUID().replace(/-/g, '').padEnd(64, '0')}`,
        });

        const journalCorrelationId =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            request.correlationId,
          )
            ? request.correlationId
            : randomUUID();
        const eventType = response.decision === 'ALLOW' ? 'RECEIPT_ISSUED' : 'ACTION_REJECTED';
        const journal = await appendEvidence(client, {
          aggregateType: 'asset',
          aggregateId: parsed.data.assetId,
          eventType,
          observedAt: new Date(evaluatedAt),
          sourceKind: 'SYSTEM',
          sourceLocator: '/v1/preflight',
          payload:
            response.decision === 'ALLOW'
              ? {
                  receiptId: response.receipt.receiptId,
                  chainId: response.receipt.chainId,
                  adapterAddress: response.receipt.verifyingContract.toLowerCase(),
                  operationDigest: response.operationDigest,
                  validAfter: response.receipt.validAfter,
                  validUntil: response.receipt.validUntil,
                  principalId: principal.id,
                  evidenceIds: response.evidence.evidenceIds,
                }
              : {
                  chainId: parsed.data.chainId,
                  operationDigest: response.operationDigest,
                  principalId: principal.id,
                  reasonCodes: response.reasonCodes,
                  evidenceIds: response.evidence.evidenceIds,
                },
          correlationId: journalCorrelationId,
          producerVersion: `api@${process.env['npm_package_version'] ?? '0.1.0'}`,
        });
        await applyEventToProjections(client, journal.event);
        await completeIdempotentCommand(client, {
          actorId: principal.id,
          operation: 'preflight',
          key: commandKey,
          requestHash,
          response,
        });
        return { kind: 'COMPLETED' as const, response };
      });

      if (outcome.kind === 'REQUEST_MISMATCH') {
        return send(
          reply,
          problem.conflict('This Idempotency-Key was already used for a different request.'),
        );
      }
      if (outcome.kind === 'IN_FLIGHT') {
        return send(
          reply,
          problem.conflict('This idempotent request is still in progress. Retry shortly.'),
        );
      }
      const response = outcome.response;

      logger.info('preflight evaluated', {
        correlationId: request.correlationId,
        assetId: parsed.data.assetId,
        decision: response.decision,
        reasonCodes: response.reasonCodes,
        principal: request.principal?.id,
      });

      return response;
    },
  );

  // --- Operator ------------------------------------------------------------

  app.post(
    '/v1/incidents/:incidentId/review-resolution',
    { preHandler: requireScope('operator:review') },
    async (request, reply) => {
      const parsed = reviewResolutionSchema.safeParse(request.body);
      if (!parsed.success) {
        return send(
          reply,
          problem.badRequest(
            'A resolution requires a specific reason and at least one evidence reference.',
            parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          ),
        );
      }
      const { incidentId } = request.params as { incidentId: string };
      const principal = request.principal;
      if (principal === undefined) return send(reply, problem.unauthorized());

      const resolution = await withTransaction(deps.db, async (client) => {
        const incident = await client.query<{ asset_id: string; status: string }>(
          `SELECT asset_id, status FROM current_incidents
           WHERE incident_id::text = $1 FOR UPDATE`,
          [incidentId],
        );
        const row = incident.rows[0];
        if (row === undefined) return { kind: 'NOT_FOUND' as const };
        if (row.status === 'RESOLVED' || row.status === 'RECOVERED') {
          return { kind: 'ALREADY_RESOLVED' as const };
        }

        const evidence = await client.query<{ id: string }>(
          `SELECT id::text AS id FROM evidence_events WHERE id::text = ANY($1::text[])`,
          [parsed.data.evidenceIds],
        );
        if (evidence.rows.length !== new Set(parsed.data.evidenceIds).size) {
          return { kind: 'EVIDENCE_NOT_FOUND' as const };
        }

        const { event } = await appendEvidence(client, {
          aggregateType: 'asset',
          aggregateId: row.asset_id,
          eventType: 'MANUAL_REVIEW_RESOLVED',
          observedAt: new Date(now()),
          sourceKind: 'OPERATOR',
          sourceLocator: '/v1/incidents/:incidentId/review-resolution',
          payload: {
            incidentId,
            reason: parsed.data.reason,
            evidenceIds: parsed.data.evidenceIds,
            actorId: principal.id,
            protectedActionsResumed: false,
          },
          correlationId: randomUUID(),
          producerVersion: `api@${process.env['npm_package_version'] ?? '0.1.0'}`,
        });
        await applyEventToProjections(client, event);
        return { kind: 'RECORDED' as const };
      });

      if (resolution.kind === 'NOT_FOUND') {
        return send(reply, problem.notFound(`No incident ${incidentId}.`));
      }
      if (resolution.kind === 'ALREADY_RESOLVED') {
        return send(reply, problem.conflict(`Incident ${incidentId} is already resolved.`));
      }
      if (resolution.kind === 'EVIDENCE_NOT_FOUND') {
        return send(
          reply,
          problem.badRequest('Every evidenceIds entry must reference an existing journal event.'),
        );
      }

      logger.info('review resolution recorded', {
        correlationId: request.correlationId,
        incidentId,
        actor: principal.id,
      });

      // A resolution records a decision. It cannot assert that the sources now agree, and
      // the response says so explicitly rather than letting the UI imply otherwise.
      return reply.code(202).send({
        incidentId,
        recorded: true,
        protectedActionsResumed: false,
        note: 'Resolution recorded. Protected actions remain governed by current evidence and are not resumed by this action.',
      });
    },
  );

  return app;
}

function serializeAsset(asset: Awaited<ReturnType<typeof getAsset>> & object) {
  return {
    assetId: asset.assetId,
    symbol: asset.symbol,
    chainId: asset.chainId,
    tokenAddress: asset.tokenAddress,
    wrapperAddress: asset.wrapperAddress,
    wrapperIsCurrent: asset.wrapperIsCurrent,
    multiplier:
      asset.multiplierValue === null || asset.multiplierDecimals === null
        ? null
        : { value: asset.multiplierValue, decimals: asset.multiplierDecimals },
    multiplierNonce: asset.multiplierNonce,
    scheduledActivation: asset.scheduledActivation?.toISOString() ?? null,
    lifecycleState: asset.lifecycleState,
    canonicality: asset.canonicality,
    apiObservedAt: asset.apiObservedAt?.toISOString() ?? null,
    chainObservedAt: asset.chainObservedAt?.toISOString() ?? null,
    chainBlockNumber: asset.chainBlockNumber,
    chainBlockHash: asset.chainBlockHash,
    sourceAgreement: asset.sourceAgreement,
    comparisonFields: asset.comparisonFields,
    comparedAt: asset.comparedAt?.toISOString() ?? null,
  };
}
