import { z } from 'zod';

/**
 * HTTP contract schemas.
 *
 * Everything crossing the boundary is validated: params, query, body, and response.
 * Response validation matters as much as request validation — it is what stops a refactor
 * quietly changing the contract the SDK and the console depend on.
 */

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address');

/** Base units as a decimal string. A JSON number cannot hold a uint256. */
export const amountSchema = z
  .string()
  .regex(/^[0-9]{1,78}$/, 'must be a base-unit integer string')
  .refine((v) => {
    try {
      return BigInt(v) > 0n;
    } catch {
      return false;
    }
  }, 'must be greater than zero');

export const nonceSchema = z
  .string()
  .regex(/^[0-9]{1,78}$/, 'must be a non-negative integer string');

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'may contain only letters, digits, and . _ : -');

export const paginationSchema = z
  .object({
    // Bounded so a client cannot request the whole catalog in one response.
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(512).optional(),
  })
  .strict();

export const assetFilterSchema = paginationSchema
  .extend({
    lifecycleState: z
      .enum([
        'NORMAL',
        'PENDING',
        'GUARD_WINDOW',
        'APPLIED',
        'RECONCILED',
        'MISMATCH',
        'MANUAL_REVIEW',
        'RECOVERED',
      ])
      .optional(),
    canonicality: z.enum(['PASS', 'FAIL', 'UNKNOWN']).optional(),
    staleEvidence: z
      .union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')])
      .optional(),
    search: z.string().max(64).optional(),
  })
  .strict();

export const incidentFilterSchema = z
  .object({
    status: z.enum(['OPEN', 'IN_REVIEW', 'RESOLVED', 'RECOVERED']).optional(),
    assetId: z.string().min(1).max(128).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const timelineQuerySchema = z
  .object({
    upToEventId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();

export const preflightRequestSchema = z
  .object({
    chainId: z.number().int().positive(),
    assetId: z.string().min(1).max(128),
    target: addressSchema,
    asset: addressSchema,
    wrapper: addressSchema,
    actionType: z.enum(['DEPOSIT', 'WITHDRAW', 'TRANSFER', 'REDEEM']),
    caller: addressSchema,
    recipient: addressSchema,
    amount: amountSchema,
    expectedMultiplierNonce: nonceSchema,
  })
  .strict();

export type PreflightRequest = z.infer<typeof preflightRequestSchema>;

/**
 * The preflight response.
 *
 * `receipt` is present **only** for ALLOW. The schema encodes that with a discriminated
 * union rather than an optional field, so a BLOCK carrying a receipt cannot be
 * represented, let alone serialized.
 */
export const preflightAllowSchema = z.object({
  decision: z.literal('ALLOW'),
  requestId: z.string(),
  evaluatedAt: z.string(),
  reasonCodes: z.tuple([]),
  evidence: z.object({
    apiEvidenceAgeMs: z.number().nullable(),
    chainEvidenceAgeMs: z.number().nullable(),
    evidenceIds: z.array(z.string()),
    blockNumber: z.string().nullable(),
    blockHash: z.string().nullable(),
  }),
  operationDigest: z.string(),
  receipt: z.object({
    schemaVersion: z.number().int(),
    receiptId: z.string(),
    caller: addressSchema,
    target: addressSchema,
    asset: addressSchema,
    wrapper: addressSchema,
    actionType: z.number().int().min(1).max(255),
    recipient: addressSchema,
    amount: nonceSchema,
    expectedMultiplierNonce: nonceSchema,
    operationDigest: z.string(),
    signature: z.string(),
    signer: addressSchema,
    validAfter: z.string(),
    validUntil: z.string(),
    verifyingContract: addressSchema,
    chainId: z.number().int(),
  }),
});

export const preflightBlockSchema = z.object({
  decision: z.literal('BLOCK'),
  requestId: z.string(),
  evaluatedAt: z.string(),
  reasonCodes: z.array(z.string()).min(1),
  reasonExplanations: z.array(z.object({ code: z.string(), explanation: z.string() })),
  evidence: z.object({
    apiEvidenceAgeMs: z.number().nullable(),
    chainEvidenceAgeMs: z.number().nullable(),
    evidenceIds: z.array(z.string()),
    blockNumber: z.string().nullable(),
    blockHash: z.string().nullable(),
  }),
  operationDigest: z.string(),
  // Structurally absent. Not optional, not null — absent.
});

export const preflightResponseSchema = z.discriminatedUnion('decision', [
  preflightAllowSchema,
  preflightBlockSchema,
]);

export type PreflightResponse = z.infer<typeof preflightResponseSchema>;

export const reviewResolutionSchema = z
  .object({
    // No one-click "mark safe": a specific written reason is mandatory.
    reason: z.string().min(20).max(2_000),
    evidenceIds: z.array(z.string().uuid()).min(1).max(100),
  })
  .strict();

export const healthResponseSchema = z.object({
  status: z.enum(['ready', 'not-ready', 'live']),
  components: z
    .array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() }))
    .optional(),
  uptimeSeconds: z.number().optional(),
});
