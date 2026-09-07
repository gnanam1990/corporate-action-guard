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

/*
 * SSRF defence for announcement URIs.
 *
 * An announcement URI is issuer-authored input that this service would dereference from
 * inside its own network, which makes it the highest-value SSRF vector in the product. The
 * gate below runs before any request is made, and a URI that fails it is still stored as
 * evidence — it is simply never fetched.
 *
 * A hostname-string blocklist is not enough on its own, and the first version of this was
 * exactly that. `https://2130706433/` is 127.0.0.1 in decimal; `https://0x7f000001/` is the
 * same address in hex; `https://[::ffff:127.0.0.1]/` is the IPv4-mapped IPv6 form. All three
 * sail past a `/^127\./` test. So every host is normalised to an address first, and the
 * decision is made on the address.
 *
 * Two gaps remain that a pre-flight string check structurally cannot close, and the fetcher
 * must close them by calling `isAllowedDestinationAddress` itself:
 *
 *  - **DNS rebinding.** A hostname that passes here can resolve to 169.254.169.254. The
 *    resolved address has to be checked, and the socket has to connect to the address that
 *    was checked.
 *  - **Redirects.** A 302 to a private address bypasses any check applied only to the
 *    original URI. Every hop is a new URI and gets the whole gate again.
 */

/** Reserved IPv4 ranges, as [network, prefix length]. */
const BLOCKED_IPV4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, and the cloud metadata endpoint
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
];

/**
 * Parse an IPv4 literal in every encoding the URL spec and common resolvers accept.
 *
 * Dotted quad, but also `127.1`, `2130706433`, `0x7f000001` and `0177.0.0.1`. Returns the
 * address as a 32-bit number, or undefined when the host is not an IPv4 literal at all.
 */
function parseIpv4(host: string): number | undefined {
  const parts = host.split('.');
  if (parts.length > 4) return undefined;

  const numbers: number[] = [];
  for (const part of parts) {
    if (part === '') return undefined;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part.slice(1), 8);
    else if (/^\d+$/.test(part)) value = Number.parseInt(part, 10);
    else return undefined;
    if (!Number.isFinite(value) || value < 0) return undefined;
    numbers.push(value);
  }

  // The last part absorbs the remaining bytes: `127.1` is 127.0.0.1, `2130706433` is the
  // whole address in one number.
  const last = numbers[numbers.length - 1];
  if (last === undefined) return undefined;
  const maxLast = 256 ** (4 - numbers.length + 1);
  if (last >= maxLast) return undefined;
  for (const value of numbers.slice(0, -1)) if (value > 255) return undefined;

  let address = last;
  for (let i = 0; i < numbers.length - 1; i++) {
    address += (numbers[i] ?? 0) * 256 ** (3 - i);
  }
  return address >>> 0;
}

function ipv4InBlockedRange(address: number): boolean {
  for (const [network, prefix] of BLOCKED_IPV4) {
    const base = parseIpv4(network);
    if (base === undefined) continue;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((address & mask) >>> 0 === (base & mask) >>> 0) return true;
  }
  return false;
}

/**
 * Decide whether a destination address or IP-literal host may be connected to.
 *
 * Exported so the fetcher can call it again on the address DNS actually returned, and again
 * on every redirect hop. That is the only way the rebinding and redirect gaps close: this
 * module cannot resolve a name and must not pretend it has.
 */
export function isAllowedDestinationAddress(host: string): {
  readonly ok: boolean;
  readonly reason?: string;
} {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();

  const ipv4 = parseIpv4(bare);
  if (ipv4 !== undefined) {
    return ipv4InBlockedRange(ipv4)
      ? { ok: false, reason: 'IPv4 literal in a reserved, loopback, private or link-local range' }
      : { ok: true };
  }

  if (bare.includes(':')) {
    // IPv4-mapped and IPv4-compatible forms carry the v4 address in the last 32 bits, and
    // that embedded address is what actually gets connected to. `URL` normalises the dotted
    // form to hex — `[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]` — so both spellings have
    // to be recognised or the normalisation itself becomes the bypass.
    const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
    const hexPair = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
    const mapped =
      dotted?.[1] !== undefined
        ? parseIpv4(dotted[1])
        : hexPair?.[1] !== undefined && hexPair[2] !== undefined
          ? ((Number.parseInt(hexPair[1], 16) << 16) | Number.parseInt(hexPair[2], 16)) >>> 0
          : undefined;
    if (mapped !== undefined && ipv4InBlockedRange(mapped)) {
      return { ok: false, reason: 'IPv4-mapped IPv6 address in a reserved range' };
    }
    if (
      bare === '::' ||
      bare === '::1' ||
      /^fe[89ab][0-9a-f]:/.test(bare) || // link-local
      /^f[cd][0-9a-f]{2}:/.test(bare) || // unique local
      /^ff[0-9a-f]{2}:/.test(bare) // multicast
    ) {
      return { ok: false, reason: 'IPv6 loopback, link-local, unique-local or multicast address' };
    }
    return { ok: true };
  }

  // A name, not a literal. Only the obviously internal suffixes can be judged here; the
  // resolved address is what the fetcher must check.
  if (
    bare === 'localhost' ||
    bare.endsWith('.localhost') ||
    bare.endsWith('.local') ||
    bare.endsWith('.internal') ||
    bare.endsWith('.home.arpa') ||
    !bare.includes('.')
  ) {
    return { ok: false, reason: 'internal or unqualified hostname' };
  }
  return { ok: true };
}

/**
 * Whether an announcement URI may be fetched at all.
 *
 * Applied before any request, and applied again to every redirect target. Passing this is
 * necessary and not sufficient: see `isAllowedDestinationAddress` for the resolved-address
 * check the fetcher still owes.
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
  return isAllowedDestinationAddress(parsed.hostname);
}
