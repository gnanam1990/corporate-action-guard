import { z } from 'zod';
import {
  assetFilterSchema,
  healthResponseSchema,
  preflightRequestSchema,
  preflightResponseSchema,
  reviewResolutionSchema,
} from './schemas.js';

/**
 * The versioned OpenAPI contract.
 *
 * Generated from the SAME Zod schemas the server validates with, so the published contract
 * cannot drift from the enforced one. A hand-maintained spec beside runtime validation
 * always ends up describing a slightly different API than the one that exists, and the
 * difference is discovered by an integrator, in production.
 *
 * CI regenerates this and fails on any diff.
 */

export const API_VERSION = '1.0.0';

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }) as Record<
    string,
    unknown
  >;
}

const problemSchema = {
  type: 'object',
  required: ['type', 'title', 'status'],
  properties: {
    type: { type: 'string', format: 'uri' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    correlationId: { type: 'string' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, message: { type: 'string' } },
      },
    },
  },
} as const;

const problemResponse = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
});

const json = (ref: string, description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } },
});

export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Corporate Action Guard API',
      version: API_VERSION,
      description:
        'Fail-closed preflight authorization for integrations acting on xStocks corporate-action state. ' +
        'A receipt is issued only for an ALLOW decision. The guard is enforceable only for paths that route ' +
        'through ActionGuardAdapter; a direct ERC-20 transfer bypasses it. X Layer mainnet is read-only.',
      license: { name: 'MIT' },
    },
    servers: [{ url: 'http://localhost:4000', description: 'Local development' }],
    tags: [
      { name: 'health', description: 'Liveness and readiness' },
      { name: 'evidence', description: 'Public read-only evidence' },
      { name: 'preflight', description: 'Operation authorization' },
      { name: 'operator', description: 'Incident review' },
    ],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description:
            'Format cag_<keyId>_<secret>. Only the sha256 hash is stored server-side; the raw key is never logged.',
        },
      },
      schemas: {
        Problem: problemSchema,
        Health: jsonSchema(healthResponseSchema),
        AssetFilter: jsonSchema(assetFilterSchema),
        PreflightRequest: jsonSchema(preflightRequestSchema),
        // A discriminated union: a BLOCK carrying a receipt is not representable.
        PreflightResponse: jsonSchema(preflightResponseSchema),
        ReviewResolution: jsonSchema(reviewResolutionSchema),
      },
    },
    paths: {
      '/v1/health/live': {
        get: {
          tags: ['health'],
          summary: 'Process liveness. Does not depend on the database.',
          responses: { '200': json('Health', 'The process is running.') },
        },
      },
      '/v1/health/ready': {
        get: {
          tags: ['health'],
          summary: 'Dependency readiness. Reports real reachability, never a hard-coded value.',
          responses: {
            '200': json('Health', 'Every mandatory dependency is reachable.'),
            '503': json('Health', 'A mandatory dependency is unavailable.'),
          },
        },
      },
      '/v1/assets': {
        get: {
          tags: ['evidence'],
          summary:
            'List discovered assets with lifecycle state, canonicality, and evidence freshness.',
          description:
            'Keyset pagination. Offset pagination would silently skip or repeat rows as projections update ' +
            'underneath a paging client, which for an evidence console means an asset in a bad state could ' +
            'scroll past unseen. Every response carries servedAt.',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
            },
            {
              name: 'cursor',
              in: 'query',
              schema: { type: 'string' },
              description: 'Opaque; from a prior nextCursor.',
            },
            { name: 'lifecycleState', in: 'query', schema: { type: 'string' } },
            {
              name: 'canonicality',
              in: 'query',
              schema: { type: 'string', enum: ['PASS', 'FAIL', 'UNKNOWN'] },
            },
            { name: 'search', in: 'query', schema: { type: 'string', maxLength: 64 } },
          ],
          responses: {
            '200': { description: 'A page of assets.' },
            '400': problemResponse('An unrecognised filter is rejected rather than ignored.'),
          },
        },
      },
      '/v1/assets/{assetId}': {
        get: {
          tags: ['evidence'],
          summary: 'One asset with its current canonicality and evidence provenance.',
          parameters: [{ name: 'assetId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'The asset.' },
            '404': problemResponse('No such asset. An empty shell is never returned in its place.'),
          },
        },
      },
      '/v1/system/coverage': {
        get: {
          tags: ['evidence'],
          summary:
            'The four coverage metrics, counted in one pass so they are mutually consistent.',
          responses: { '200': { description: 'Coverage counts.' } },
        },
      },
      '/v1/system/source-health': {
        get: {
          tags: ['evidence'],
          summary: 'Per-source health with last success and last failure instants.',
          responses: { '200': { description: 'Source health.' } },
        },
      },
      '/v1/incidents': {
        get: {
          tags: ['evidence'],
          summary: 'Open and resolved incidents, ordered by deterministic severity then recency.',
          description:
            'Severity is a deterministic category. There is no numeric or model-generated risk score.',
          parameters: [
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: ['OPEN', 'IN_REVIEW', 'RESOLVED', 'RECOVERED'] },
            },
            { name: 'assetId', in: 'query', schema: { type: 'string' } },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
            },
          ],
          responses: { '200': { description: 'Incidents.' } },
        },
      },
      '/v1/preflight': {
        post: {
          tags: ['preflight'],
          summary: 'Authorize one exact operation, or refuse it.',
          description:
            'Returns ALLOW with a short-lived EIP-712 receipt bound to this exact operation, or BLOCK with ' +
            'stable reason codes and NO receipt. A receipt is never returned for a BLOCK, for degraded ' +
            'evidence, or for an UNKNOWN check. An Idempotency-Key header is mandatory: a retried preflight ' +
            'must not mint a second receipt for the same intent.',
          security: [{ apiKey: [] }],
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string', minLength: 8, maxLength: 128 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PreflightRequest' } },
            },
          },
          responses: {
            '200': json(
              'PreflightResponse',
              'An ALLOW with a receipt, or a BLOCK with reason codes.',
            ),
            '400': problemResponse('Invalid request, or a missing Idempotency-Key.'),
            '401': problemResponse(
              'Authentication failed. The body is identical for every failure reason.',
            ),
            '403': problemResponse('The key lacks the integrator:preflight scope.'),
            '429': problemResponse('Rate limited.'),
          },
        },
      },
      '/v1/incidents/{incidentId}/review-resolution': {
        post: {
          tags: ['operator'],
          summary: 'Record an operator resolution. Does not resume protected actions.',
          description:
            'A resolution records a decision with an actor, a specific reason, and an evidence reference. It ' +
            'cannot create source agreement: the response always reports protectedActionsResumed=false, and ' +
            'protected actions remain governed by current evidence.',
          security: [{ apiKey: [] }],
          parameters: [
            { name: 'incidentId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ReviewResolution' } },
            },
          },
          responses: {
            '202': { description: 'Recorded. Protected actions are not resumed.' },
            '400': problemResponse('A specific reason and an evidence reference are mandatory.'),
            '403': problemResponse('The key lacks the operator:review scope.'),
          },
        },
      },
    },
  };
}
