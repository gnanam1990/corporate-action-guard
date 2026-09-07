/**
 * Corporate-action correlation, and everything it refuses to conclude.
 *
 * The first block of tests is the important one. A 10× multiplier increase looks exactly like
 * a 10:1 forward split, and a dashboard that says `FORWARD_SPLIT` reads better than one that
 * says `UNKNOWN`. ADR 0008 says it stays UNKNOWN without structured evidence, and these are
 * the tests that make that survive contact with a demo.
 */
import { describe, expect, it } from 'vitest';
import {
  correlateB20Cases,
  isFetchableAnnouncementUri,
  sanitizeAnnouncementText,
  type CorrelationInput,
  type MultiplierChangeFact,
  type StructuredActionEvidence,
} from '../src/index.js';

const CHAIN = 8453;
const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const ONE = 1_000_000_000_000_000_000n;
const NOW = 1_788_776_091n;

const split: MultiplierChangeFact = {
  eventId: 'event-multiplier-1',
  blockNumber: 1000n,
  transactionHash: `0x${'22'.repeat(32)}`,
  oldMultiplierWad: ONE,
  newMultiplierWad: ONE * 10n,
  effectiveAtSeconds: NOW - 3_600n,
  viaInstantOverride: false,
};

function input(overrides: Partial<CorrelationInput> = {}): CorrelationInput {
  return {
    chainId: CHAIN,
    assetAddress: AAPL,
    announcements: [
      {
        announcementId: 'CA-2026-0001',
        caller: '0xdead000000000000000000000000000000000001',
        description: 'Stock split',
        uri: 'https://issuer.example/ca/2026-0001',
        openedAtBlock: 999n,
        closedAtBlock: 1001n,
        openEventId: 'event-announce-open',
        closeEventId: 'event-announce-close',
      },
    ],
    multiplierChanges: [split],
    pauses: [
      { eventId: 'event-pause', blockNumber: 999n, paused: true, features: ['TRANSFER'] },
      { eventId: 'event-unpause', blockNumber: 1002n, paused: false, features: ['TRANSFER'] },
    ],
    feedRounds: [
      {
        eventId: 'event-round',
        blockNumber: 1003n,
        roundId: 100n,
        answer: 3_200_800_000n,
        updatedAtSeconds: NOW - 60n,
      },
    ],
    evaluateAtSeconds: NOW,
    slaSeconds: 86_400n,
    ...overrides,
  };
}

const structured = (
  overrides: Partial<StructuredActionEvidence> = {},
): StructuredActionEvidence => ({
  eventType: 'FORWARD_SPLIT',
  ratioNumerator: 10n,
  ratioDenominator: 1n,
  attestedBy: 'operator:ops-team',
  attestedAt: '2026-09-07T00:00:00.000Z',
  sourceHash: `0x${'ab'.repeat(32)}`,
  ...overrides,
});

describe('classification refuses to guess', () => {
  it('leaves a textbook 10x increase UNKNOWN with no structured evidence', () => {
    // The whole point. Everything about this looks like a 10:1 forward split — the ratio, the
    // announcement titled "Stock split", the pause window. None of that types it.
    const [result] = correlateB20Cases(input());
    expect(result?.businessEvent).toBe('UNKNOWN');
    expect(result?.classificationStatus).toBe('UNKNOWN');
    expect(result?.reasons).toContain('B20_UNCLASSIFIED_BUSINESS_EVENT');
  });

  it('still reconciles the on-chain state change while refusing to name it', () => {
    // Refusing to classify must not mean refusing to reconcile. The multiplier moved, and the
    // customer's ledger has to know that.
    const [result] = correlateB20Cases(input());
    expect(result?.multiplierBeforeWad).toBe(ONE);
    expect(result?.multiplierAfterWad).toBe(ONE * 10n);
    expect(result?.evidenceEventIds).toContain('event-multiplier-1');
  });

  it('is not persuaded by the announcement description', () => {
    const [result] = correlateB20Cases(
      input({
        announcements: [
          {
            ...input().announcements[0]!,
            description: 'CONFIRMED 10:1 FORWARD SPLIT, EFFECTIVE IMMEDIATELY',
          },
        ],
      }),
    );
    expect(result?.classificationStatus).toBe('UNKNOWN');
  });

  it('verifies only when structured evidence reproduces the observed change exactly', () => {
    const [result] = correlateB20Cases(input({ structuredEvidence: structured() }));
    expect(result?.classificationStatus).toBe('VERIFIED');
    expect(result?.businessEvent).toBe('FORWARD_SPLIT');
  });

  it('conflicts when the declared ratio does not reproduce the change', () => {
    // A 10:1 split that moved the multiplier by 5x is not a 10:1 split, whatever the record
    // says. Believing the record over the chain is how a wrong label reaches a ledger.
    const [result] = correlateB20Cases(
      input({ structuredEvidence: structured({ ratioNumerator: 5n }) }),
    );
    expect(result?.classificationStatus).toBe('CONFLICT');
  });

  it('ignores structured evidence with no attestation or source hash', () => {
    // An unsigned claim is a claim, not evidence.
    expect(
      correlateB20Cases(input({ structuredEvidence: structured({ attestedBy: '  ' }) }))[0]
        ?.classificationStatus,
    ).toBe('UNKNOWN');
    expect(
      correlateB20Cases(input({ structuredEvidence: structured({ sourceHash: '' }) }))[0]
        ?.classificationStatus,
    ).toBe('UNKNOWN');
  });

  it('cannot verify without a before-value to check the ratio against', () => {
    const { oldMultiplierWad: _omitted, ...withoutBefore } = split;
    const [result] = correlateB20Cases(
      input({ multiplierChanges: [withoutBefore], structuredEvidence: structured() }),
    );
    expect(result?.classificationStatus).toBe('CONFLICT');
  });
});

describe('correlation reports what is missing by name', () => {
  it('flags a multiplier change with no announcement bracket', () => {
    // Legal on chain, and worth surfacing: the issuer changed a holder's share count with no
    // disclosure event attached.
    const [result] = correlateB20Cases(input({ announcements: [] }));
    expect(result?.missingRequirements.join(' ')).toContain('no announcement bracket');
  });

  it('flags an announcement that was never closed', () => {
    const [result] = correlateB20Cases(
      input({
        announcements: [
          { ...input().announcements[0]!, closedAtBlock: undefined, closeEventId: undefined },
        ],
      }),
    );
    expect(result?.missingRequirements.join(' ')).toContain('never closed');
  });

  it('flags an asset still paused for an action', () => {
    const [result] = correlateB20Cases(
      input({
        pauses: [{ eventId: 'p', blockNumber: 999n, paused: true, features: ['TRANSFER'] }],
      }),
    );
    expect(result?.missingRequirements.join(' ')).toContain('has not been unpaused');
  });

  it('treats an unpause before any realigned feed round as a conflict', () => {
    // The first trade after that unpause prices against a stale basis.
    const [result] = correlateB20Cases(input({ feedRounds: [] }));
    expect(result?.outcome).toBe('CONFLICT');
    expect(result?.reasons).toContain('B20_FEED_REGISTRY_DISAGREEMENT');
  });

  it('reports a scheduled action as PENDING rather than incomplete', () => {
    const [result] = correlateB20Cases(
      input({
        multiplierChanges: [{ ...split, effectiveAtSeconds: NOW + 86_400n }],
      }),
    );
    expect(result?.outcome).toBe('PENDING');
  });

  it('escalates an incomplete case that outran its SLA', () => {
    // Silence past a deadline is a finding, not a state to keep waiting in.
    const [result] = correlateB20Cases(
      input({
        announcements: [],
        multiplierChanges: [{ ...split, effectiveAtSeconds: NOW - 200_000n }],
        slaSeconds: 3_600n,
      }),
    );
    expect(result?.outcome).toBe('MANUAL_REVIEW');
    expect(result?.reasons).toContain('B20_MANUAL_REVIEW_REQUIRED');
  });

  it('records a metadata-only announcement as its own case', () => {
    // A rename is something a customer integration can get wrong and needs to see.
    const cases = correlateB20Cases(input({ multiplierChanges: [] }));
    expect(cases).toHaveLength(1);
    expect(cases[0]?.outcome).toBe('INSUFFICIENT_EVIDENCE');
    expect(cases[0]?.missingRequirements.join(' ')).toContain('no multiplier change');
  });

  it('produces nothing when there is nothing to correlate', () => {
    expect(correlateB20Cases(input({ announcements: [], multiplierChanges: [] }))).toEqual([]);
  });
});

describe('announcement text is data', () => {
  it('strips bidirectional overrides that make text render as something else', () => {
    const attack = `Split 10:1‮TIDERC 000,001 DNES‬`;
    const safe = sanitizeAnnouncementText(attack);
    expect(safe).not.toContain('‮');
    expect(safe).not.toContain('‬');
  });

  it('strips control characters and zero-width joiners', () => {
    const safe = sanitizeAnnouncementText('a b​cd');
    expect(safe).toBe('a b c d');
  });

  it('bounds the length so one announcement cannot fill a page', () => {
    expect(sanitizeAnnouncementText('x'.repeat(10_000), 100)).toHaveLength(101);
  });

  it('leaves ordinary text readable', () => {
    expect(sanitizeAnnouncementText('  Forward split 10:1  effective 2026-09-08 ')).toBe(
      'Forward split 10:1 effective 2026-09-08',
    );
  });
});

describe('announcement URIs are checked before anything is fetched', () => {
  it('accepts a plain https URL', () => {
    expect(isFetchableAnnouncementUri('https://issuer.example/ca/1').ok).toBe(true);
  });

  it('refuses anything but https', () => {
    expect(isFetchableAnnouncementUri('http://issuer.example/ca/1').ok).toBe(false);
    expect(isFetchableAnnouncementUri('file:///etc/passwd').ok).toBe(false);
    expect(isFetchableAnnouncementUri('gopher://issuer.example/1').ok).toBe(false);
  });

  it('refuses loopback, private and link-local destinations', () => {
    // An announcement URI is issuer-controlled input that this service would fetch from
    // inside its own network. Every one of these is a route to something not meant to be
    // reachable from outside.
    for (const uri of [
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://10.0.0.5/x',
      'https://192.168.1.1/x',
      'https://172.16.0.1/x',
      'https://169.254.169.254/latest/meta-data/',
      'https://metadata.internal/x',
      'https://db.local/x',
    ]) {
      expect(isFetchableAnnouncementUri(uri).ok, uri).toBe(false);
    }
  });

  it('refuses credentials embedded in the URI', () => {
    expect(isFetchableAnnouncementUri('https://user:pass@issuer.example/x').ok).toBe(false);
  });

  it('refuses a non-default port', () => {
    expect(isFetchableAnnouncementUri('https://issuer.example:8443/x').ok).toBe(false);
  });

  it('refuses something that is not a URI at all', () => {
    expect(isFetchableAnnouncementUri('not a uri').ok).toBe(false);
  });
});
