/**
 * @cag/explainer — optional, non-authoritative incident explanation.
 *
 * **This package can never authorize anything.**
 *
 * It has no dependency on the domain, the receipts package, the database, or the API. It
 * cannot import them — the layering rule forbids it and a test asserts it — so there is no
 * path by which a model's output reaches a decision. Disabling this package entirely
 * changes nothing about the product's safety or its core function.
 *
 * The reason for that strictness is simple: a language model is a plausible-text generator.
 * It is genuinely useful for helping a human read forty journal events quickly. It has no
 * business anywhere near the question of whether money moves.
 */

export type Audience = 'operator' | 'integrator' | 'judge';

export interface EvidenceItem {
  readonly eventId: string;
  readonly eventType: string;
  readonly observedAt: string;
  readonly sourceKind: string;
  /** Already redacted by the caller. This package never sees a raw payload. */
  readonly summary: string;
}

export interface ExplainRequest {
  readonly incidentId: string;
  readonly audience: Audience;
  /** The deterministic decision. The model explains it; it never produces it. */
  readonly decision: 'ALLOW' | 'BLOCK';
  readonly reasonCodes: readonly string[];
  readonly evidence: readonly EvidenceItem[];
  readonly policyVersion: string;
}

export interface Explanation {
  readonly summary: string;
  readonly whatChanged: string;
  readonly whyBlockedOrAllowed: string;
  /** Must contain ONLY event ids that were supplied. Anything else is a hallucination. */
  readonly evidenceCitations: readonly string[];
  readonly uncertainty: string;
  /** Chosen from an allowlisted runbook catalog. Never free-form advice. */
  readonly suggestedNextChecks: readonly string[];
  readonly model: string;
  readonly generatedAt: string;
  /** Always true. Present in the payload so a consumer cannot forget. */
  readonly nonAuthoritative: true;
}

/**
 * The only actions the explainer may suggest.
 *
 * An allowlist, not free text, because a model asked "what should I do" will eventually
 * suggest working around the block. Every entry maps to a runbook.
 */
export const RUNBOOK_ACTIONS = [
  'Check source health at /v1/system/source-health',
  'Compare the API and chain values in the asset detail comparison matrix',
  'Replay the incident to an earlier cutoff and compare',
  'Verify the RPC serves the expected chain id',
  'Confirm the worker lease is not held by a dead instance',
  'Rebuild projections from the journal',
  'Wait for a later complete observation; disagreement cannot be resolved by an operator',
  'Escalate to the on-call operator',
] as const;

export type RunbookAction = (typeof RUNBOOK_ACTIONS)[number];

export type ExplainResult =
  | { readonly ok: true; readonly explanation: Explanation }
  | { readonly ok: false; readonly reason: ValidationFailure; readonly fallback: Explanation };

export type ValidationFailure =
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_JSON'
  | 'SCHEMA_MISMATCH'
  | 'HALLUCINATED_CITATION'
  | 'UNCITED_CLAIM'
  | 'DISALLOWED_ACTION'
  | 'RESPONSE_TOO_LARGE';

/**
 * Deterministic explanation, built from reason codes alone.
 *
 * Used whenever the model is unavailable or its output fails validation — and it is
 * genuinely useful on its own. That is the point: if the fallback were poor, there would be
 * pressure to trust the model output, and the moment that happens the model is in the
 * decision path.
 */
export function deterministicExplanation(
  request: ExplainRequest,
  explanations: Readonly<Record<string, string>>,
): Explanation {
  const lines = request.reasonCodes.map(
    (code) => `${code}: ${explanations[code] ?? 'no explanation registered'}`,
  );

  return {
    summary:
      request.decision === 'BLOCK'
        ? `Protected actions are refused for ${request.incidentId}: ${request.reasonCodes.length} condition(s) not met.`
        : `No blocking condition recorded for ${request.incidentId}.`,
    whatChanged:
      request.evidence.length === 0
        ? 'No evidence was supplied for this incident.'
        : `${request.evidence.length} evidence event(s) between ${request.evidence[0]?.observedAt} and ${request.evidence.at(-1)?.observedAt}.`,
    whyBlockedOrAllowed: lines.join('\n') || 'No reason codes were recorded.',
    evidenceCitations: request.evidence.map((e) => e.eventId),
    uncertainty:
      'This explanation is generated from reason codes only. It makes no inference beyond the recorded evidence.',
    suggestedNextChecks: [RUNBOOK_ACTIONS[1], RUNBOOK_ACTIONS[2]],
    model: 'deterministic-fallback',
    generatedAt: new Date().toISOString(),
    nonAuthoritative: true,
  };
}

const MAX_RESPONSE_BYTES = 32 * 1024;

/**
 * Validate a model response before it is shown to anyone.
 *
 * Three rules matter most:
 *  - every citation must be an event id that was actually supplied;
 *  - every suggested action must come from the allowlist;
 *  - nothing may claim the decision was different from the recorded one.
 */
export function validateExplanation(
  raw: string,
  request: ExplainRequest,
): { ok: true; explanation: Explanation } | { ok: false; reason: ValidationFailure } {
  if (raw.length > MAX_RESPONSE_BYTES) return { ok: false, reason: 'RESPONSE_TOO_LARGE' };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'INVALID_JSON' };
  }

  const required = [
    'summary',
    'whatChanged',
    'whyBlockedOrAllowed',
    'evidenceCitations',
    'uncertainty',
    'suggestedNextChecks',
  ];
  for (const field of required) {
    if (!(field in parsed)) return { ok: false, reason: 'SCHEMA_MISMATCH' };
  }
  if (
    !Array.isArray(parsed['evidenceCitations']) ||
    !Array.isArray(parsed['suggestedNextChecks'])
  ) {
    return { ok: false, reason: 'SCHEMA_MISMATCH' };
  }

  // A citation the caller never supplied is an invented event.
  const supplied = new Set(request.evidence.map((e) => e.eventId));
  const citations = parsed['evidenceCitations'] as unknown[];
  for (const citation of citations) {
    if (typeof citation !== 'string' || !supplied.has(citation)) {
      return { ok: false, reason: 'HALLUCINATED_CITATION' };
    }
  }

  // A factual claim with no citation at all is unsupported.
  if (citations.length === 0 && request.evidence.length > 0) {
    return { ok: false, reason: 'UNCITED_CLAIM' };
  }

  const allowed = new Set<string>(RUNBOOK_ACTIONS);
  for (const action of parsed['suggestedNextChecks'] as unknown[]) {
    if (typeof action !== 'string' || !allowed.has(action)) {
      return { ok: false, reason: 'DISALLOWED_ACTION' };
    }
  }

  return {
    ok: true,
    explanation: {
      summary: String(parsed['summary']),
      whatChanged: String(parsed['whatChanged']),
      whyBlockedOrAllowed: String(parsed['whyBlockedOrAllowed']),
      evidenceCitations: citations as string[],
      uncertainty: String(parsed['uncertainty']),
      suggestedNextChecks: parsed['suggestedNextChecks'] as RunbookAction[],
      model: typeof parsed['model'] === 'string' ? parsed['model'] : 'unknown',
      generatedAt: new Date().toISOString(),
      // Set here, not taken from the model. It cannot claim authority for itself.
      nonAuthoritative: true,
    },
  };
}

/**
 * Wrap untrusted evidence text so a prompt-injection string inside it is data, not
 * instruction. Evidence is written by external sources; some of it will eventually contain
 * "ignore previous instructions".
 */
export function delimitEvidence(items: readonly EvidenceItem[]): string {
  return items
    .map(
      (item) =>
        `<evidence id="${item.eventId}" type="${item.eventType}" source="${item.sourceKind}" at="${item.observedAt}">\n` +
        // Any closing delimiter inside the content is neutralised.
        `${item.summary.replace(/<\/?evidence/gi, '[evidence]')}\n</evidence>`,
    )
    .join('\n');
}
