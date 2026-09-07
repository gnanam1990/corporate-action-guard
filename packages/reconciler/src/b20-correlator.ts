/**
 * Corporate-action case correlation.
 *
 * Correlation groups on-chain facts into one case by *evidence*, not by narrative. It says
 * "this announcement bracket, this multiplier change, this pause and this unpause belong
 * together, and here is what is missing." It does not say what the action *means*.
 *
 * That refusal is ADR 0008 and it is the point. A multiplier going from 1e18 to 10e18 is a
 * fact; whether it is a forward split, a reinvested dividend or a correction of an earlier
 * error is a legal question the chain does not answer. The numeric shape does not classify
 * it, the ticker does not, price movement does not, and no model output may. On Base mainnet
 * this bites harder than it would elsewhere: with the scheduling surface not dialed, the only
 * signals are the instant event and issuer-authored free text.
 *
 * Announcement text and URIs are stored as evidence with provenance and obeyed by nothing.
 */

import type { B20Reason } from '@cag/domain';

/*
 * Business-event classification.
 */

export const B20_BUSINESS_EVENTS = [
  'DIVIDEND_REINVESTMENT',
  'FORWARD_SPLIT',
  'REVERSE_SPLIT',
  'SPIN_OFF_OR_REFERENCE_CHANGE',
  'METADATA_ONLY',
  'UNKNOWN',
] as const;
export type B20BusinessEvent = (typeof B20_BUSINESS_EVENTS)[number];

/**
 * Structured issuer or reference-data evidence.
 *
 * The *only* thing that may set a classification to VERIFIED. Deliberately shaped so it
 * cannot be produced from an announcement's free text: it needs a typed event, a declared
 * ratio, and an operator or feed that vouched for it.
 */
export interface StructuredActionEvidence {
  readonly eventType: B20BusinessEvent;
  /** Declared ratio, as an exact fraction. `10:1` is `{ numerator: 10n, denominator: 1n }`. */
  readonly ratioNumerator: bigint;
  readonly ratioDenominator: bigint;
  /** Who vouched: an issuer feed identifier or a reviewing operator. Never "the description". */
  readonly attestedBy: string;
  readonly attestedAt: string;
  /** Content hash of the source record, so the claim is traceable. */
  readonly sourceHash: string;
}

/*
 * Inputs.
 */

/** An `Announcement` / `EndAnnouncement` bracket. Text is data, never instruction. */
export interface AnnouncementBracket {
  readonly announcementId: string;
  readonly caller: string;
  readonly description: string;
  readonly uri: string;
  readonly openedAtBlock: bigint;
  readonly closedAtBlock?: bigint;
  /** Hash of the fetched URI body, when fetching is enabled and succeeded. */
  readonly uriBodyHash?: string;
  readonly openEventId: string;
  readonly closeEventId?: string;
}

export interface MultiplierChangeFact {
  readonly eventId: string;
  readonly blockNumber: bigint;
  readonly transactionHash: string;
  readonly oldMultiplierWad?: bigint;
  readonly newMultiplierWad: bigint;
  readonly effectiveAtSeconds?: bigint;
  readonly viaInstantOverride: boolean;
}

export interface PauseFact {
  readonly eventId: string;
  readonly blockNumber: bigint;
  readonly paused: boolean;
  readonly features: readonly string[];
}

export interface FeedRoundFact {
  readonly eventId: string;
  readonly blockNumber: bigint;
  readonly roundId: bigint;
  readonly answer: bigint;
  readonly updatedAtSeconds: bigint;
}

export interface CorrelationInput {
  readonly chainId: number;
  readonly assetAddress: string;
  readonly announcements: readonly AnnouncementBracket[];
  readonly multiplierChanges: readonly MultiplierChangeFact[];
  readonly pauses: readonly PauseFact[];
  readonly feedRounds: readonly FeedRoundFact[];
  /** Present only when an operator-reviewed record exists. Almost always absent. */
  readonly structuredEvidence?: StructuredActionEvidence;
  /** Evaluation block timestamp. Not a wall clock. */
  readonly evaluateAtSeconds: bigint;
  /** How long an incomplete case may stay open before it becomes MANUAL_REVIEW. */
  readonly slaSeconds: bigint;
}

export const CASE_OUTCOMES = [
  'VERIFIED',
  'PENDING',
  'CONFLICT',
  'INSUFFICIENT_EVIDENCE',
  'MANUAL_REVIEW',
] as const;
export type CaseOutcome = (typeof CASE_OUTCOMES)[number];

export interface CorrelatedCase {
  readonly caseId: string;
  readonly chainId: number;
  readonly assetAddress: string;
  readonly outcome: CaseOutcome;
  /** The legal meaning. UNKNOWN unless structured evidence typed it. */
  readonly businessEvent: B20BusinessEvent;
  readonly classificationStatus: 'VERIFIED' | 'UNKNOWN' | 'CONFLICT';
  readonly reasons: readonly B20Reason[];
  /** What is present. */
  readonly evidenceEventIds: readonly string[];
  /** What is missing, named rather than scored. */
  readonly missingRequirements: readonly string[];
  readonly announcementId?: string;
  readonly multiplierBeforeWad?: bigint;
  readonly multiplierAfterWad?: bigint;
}

/**
 * Correlate one asset's facts into cases.
 *
 * One case per multiplier change, because that is the state transition a customer's ledger
 * has to survive. Announcements, pauses and feed rounds attach to a case when the evidence
 * links them; when it does not, that absence is reported as a named missing requirement
 * rather than assumed away.
 */
export function correlateB20Cases(input: CorrelationInput): readonly CorrelatedCase[] {
  const changes = [...input.multiplierChanges].sort((a, b) =>
    a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0,
  );

  if (changes.length === 0) {
    // Metadata-only activity still produces a case, because a rename is something a customer
    // integration can get wrong and needs to see.
    const metadataOnly = input.announcements.length > 0;
    if (!metadataOnly) return [];
    return input.announcements.map((announcement) => ({
      caseId: caseIdFor(input, announcement.openEventId),
      chainId: input.chainId,
      assetAddress: input.assetAddress,
      outcome: 'INSUFFICIENT_EVIDENCE' as const,
      businessEvent: 'UNKNOWN' as const,
      classificationStatus: 'UNKNOWN' as const,
      reasons: ['B20_UNCLASSIFIED_BUSINESS_EVENT'] as const,
      evidenceEventIds: [announcement.openEventId, announcement.closeEventId].filter(
        (id): id is string => id !== undefined,
      ),
      missingRequirements: ['no multiplier change accompanies this announcement'],
      announcementId: announcement.announcementId,
    }));
  }

  return changes.map((change) => buildCase(input, change));
}

function caseIdFor(input: CorrelationInput, anchorEventId: string): string {
  return `${String(input.chainId)}:${input.assetAddress.toLowerCase()}:${anchorEventId}`;
}

function buildCase(input: CorrelationInput, change: MultiplierChangeFact): CorrelatedCase {
  const reasons: B20Reason[] = [];
  const missing: string[] = [];
  const evidenceEventIds: string[] = [change.eventId];

  // An announcement brackets the calls made inside it, so the link is the transaction and
  // the block range — never a text match on the description.
  const bracket = input.announcements.find(
    (a) =>
      a.openedAtBlock <= change.blockNumber &&
      (a.closedAtBlock === undefined || a.closedAtBlock >= change.blockNumber),
  );
  if (bracket === undefined) {
    // Direct invocation without an announcement. Legal on chain, and worth surfacing: the
    // issuer changed a holder's share count with no disclosure event attached.
    missing.push('no announcement bracket contains this multiplier change');
  } else {
    evidenceEventIds.push(bracket.openEventId);
    if (bracket.closeEventId !== undefined) evidenceEventIds.push(bracket.closeEventId);
    if (bracket.closedAtBlock === undefined) {
      missing.push(`announcement ${bracket.announcementId} was never closed`);
    }
  }

  // A pause that opens before the change and an unpause after it is the shape a reverse split
  // takes. Recorded as a signal, never as a classification: a pause is also what an issuer
  // does during an unrelated incident.
  const pauseBefore = input.pauses.find((p) => p.paused && p.blockNumber <= change.blockNumber);
  const unpauseAfter = input.pauses.find((p) => !p.paused && p.blockNumber >= change.blockNumber);
  if (pauseBefore !== undefined) evidenceEventIds.push(pauseBefore.eventId);
  if (unpauseAfter !== undefined) evidenceEventIds.push(unpauseAfter.eventId);
  if (pauseBefore !== undefined && unpauseAfter === undefined) {
    missing.push('the asset was paused for this action and has not been unpaused');
  }

  // The feed must move with the multiplier before an unpause, or the first trade after the
  // unpause prices against a stale basis.
  const roundAfter = input.feedRounds.find((r) => r.blockNumber >= change.blockNumber);
  if (roundAfter !== undefined) {
    evidenceEventIds.push(roundAfter.eventId);
  } else if (unpauseAfter !== undefined) {
    reasons.push('B20_FEED_REGISTRY_DISAGREEMENT');
    missing.push('the asset was unpaused before any feed round reflected the new multiplier');
  }

  // Continuity. A break means the fact window has a hole or the observations came from
  // different branches, and guessing past it produces a confident wrong before-value.
  if (
    change.oldMultiplierWad !== undefined &&
    change.newMultiplierWad === change.oldMultiplierWad
  ) {
    reasons.push('B20_MULTIPLIER_CONTINUITY_BROKEN');
    missing.push('the change reports the same multiplier before and after');
  }

  const classification = classify(input.structuredEvidence, change);
  if (classification.status !== 'VERIFIED') {
    reasons.push('B20_UNCLASSIFIED_BUSINESS_EVENT');
    missing.push(
      'no structured issuer or reference-data evidence types this action; the on-chain ' +
        'state change is still fully reconciled',
    );
  }

  const outcome = decideOutcome(input, change, missing, reasons);
  if (outcome === 'MANUAL_REVIEW') reasons.push('B20_MANUAL_REVIEW_REQUIRED');

  return {
    caseId: caseIdFor(input, change.eventId),
    chainId: input.chainId,
    assetAddress: input.assetAddress,
    outcome,
    businessEvent: classification.event,
    classificationStatus: classification.status,
    reasons,
    evidenceEventIds,
    missingRequirements: missing,
    ...(bracket !== undefined ? { announcementId: bracket.announcementId } : {}),
    ...(change.oldMultiplierWad !== undefined
      ? { multiplierBeforeWad: change.oldMultiplierWad }
      : {}),
    multiplierAfterWad: change.newMultiplierWad,
  };
}

/**
 * Classification, and everything it refuses to do.
 *
 * The only path to VERIFIED runs through structured evidence whose declared ratio actually
 * matches the observed multiplier change. Everything else is UNKNOWN — including the cases
 * where the answer looks obvious, because "looks obvious" is exactly how a dividend
 * reinvestment gets booked as a split.
 */
function classify(
  evidence: StructuredActionEvidence | undefined,
  change: MultiplierChangeFact,
): { readonly event: B20BusinessEvent; readonly status: 'VERIFIED' | 'UNKNOWN' | 'CONFLICT' } {
  if (evidence === undefined) return { event: 'UNKNOWN', status: 'UNKNOWN' };
  if (evidence.attestedBy.trim() === '' || evidence.sourceHash.trim() === '') {
    return { event: 'UNKNOWN', status: 'UNKNOWN' };
  }
  if (change.oldMultiplierWad === undefined) {
    // Without a before-value the declared ratio cannot be checked against anything, and an
    // unchecked declaration is a claim rather than evidence.
    return { event: evidence.eventType, status: 'CONFLICT' };
  }
  if (evidence.ratioDenominator === 0n) return { event: 'UNKNOWN', status: 'CONFLICT' };

  // The declared ratio has to reproduce the observed change exactly. A 10:1 split that moved
  // the multiplier by 9.7× is not a 10:1 split, whatever the record says.
  const expected = (change.oldMultiplierWad * evidence.ratioNumerator) / evidence.ratioDenominator;
  if (expected !== change.newMultiplierWad) {
    return { event: evidence.eventType, status: 'CONFLICT' };
  }
  return { event: evidence.eventType, status: 'VERIFIED' };
}

function decideOutcome(
  input: CorrelationInput,
  change: MultiplierChangeFact,
  missing: readonly string[],
  reasons: readonly B20Reason[],
): CaseOutcome {
  if (reasons.includes('B20_MULTIPLIER_CONTINUITY_BROKEN')) return 'CONFLICT';
  if (reasons.includes('B20_FEED_REGISTRY_DISAGREEMENT')) return 'CONFLICT';

  const scheduled =
    change.effectiveAtSeconds !== undefined && change.effectiveAtSeconds > input.evaluateAtSeconds;
  if (scheduled) return 'PENDING';

  // An incomplete case that has outrun its SLA stops being "we are still waiting" and becomes
  // something a human has to look at. Silence past a deadline is a finding.
  const age = input.evaluateAtSeconds - (change.effectiveAtSeconds ?? 0n);
  if (missing.length > 0 && age > input.slaSeconds) return 'MANUAL_REVIEW';
  if (missing.length > 0) return 'INSUFFICIENT_EVIDENCE';
  return 'VERIFIED';
}

/**
 * Announcement text and URIs, rendered safe.
 *
 * Issuer-authored, untrusted, and rendered next to numbers an operator acts on. Control
 * characters are stripped, the length is bounded, and the text is never parsed for meaning.
 * Anything inside it that reads like an instruction is data.
 */
/* eslint-disable no-control-regex -- matching control characters is this function's job. */
export function sanitizeAnnouncementText(text: string, maxLength = 512): string {
  // C0 and C1 controls, plus the bidirectional-override and zero-width ranges that let a
  // string render as something other than what it contains. An announcement is displayed
  // beside numbers an operator acts on, so a right-to-left override inside one is an attack,
  // not a formatting quirk. Written as escapes so the source itself stays inspectable.
  const stripped = text.replace(
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/gu,
    ' ',
  );
  const collapsed = stripped.replace(/\s+/gu, ' ').trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength)}\u2026` : collapsed;
}
/* eslint-enable no-control-regex */

/**
 * Whether an announcement URI may be fetched at all.
 *
 * SSRF defence, applied before any request. HTTPS only, no credentials in the URL, no
 * private, loopback or link-local destination, and no non-default port. A URI that fails
 * this is still stored as evidence — it is simply never dereferenced.
 */
export function isFetchableAnnouncementUri(uri: string): {
  readonly ok: boolean;
  readonly reason?: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { ok: false, reason: 'not a valid absolute URI' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'only https is fetched' };
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'credentials in a URI are never sent' };
  }
  if (parsed.port !== '' && parsed.port !== '443') {
    return { ok: false, reason: 'only the default https port is fetched' };
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    /^\[?::1\]?$/.test(host) ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^\[?fd[0-9a-f]{2}:/i.test(host) ||
    /^\[?fe80:/i.test(host)
  ) {
    return { ok: false, reason: 'private, loopback, or link-local destination' };
  }
  return { ok: true };
}
