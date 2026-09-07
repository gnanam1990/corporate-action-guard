/**
 * The B20 reconciliation state machine.
 *
 * Two things are being proved. That every legal transition is reachable and every illegal one
 * is rejected — a machine whose edges are only implied is a machine nobody can reason about.
 * And that missing data never becomes a match: for each way evidence can be absent there is a
 * test showing the machine moves *away* from VERIFIED, by its own named path.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allLegalB20Transitions,
  B20_STATES,
  IllegalTransitionError,
  incidentSignature,
  isLegalTransition,
  needsNewEvidence,
  nextB20State,
  type B20MachineInput,
  type B20State,
} from '../src/index.js';

const NOW = 1_788_776_091n;

/** A healthy asset with every mandatory source present, comparable and agreeing. */
function healthy(overrides: Partial<B20MachineInput> = {}): B20MachineInput {
  return {
    assetVerified: true,
    assetIsFixture: false,
    capabilityScheduledUpdates: 'LIVE',
    rpcReachable: true,
    pendingSchedule: undefined,
    guardWindowSeconds: 3_600n,
    evaluateAtSeconds: NOW,
    feedVerdict: 'FRESH',
    feedPairingReviewed: true,
    tokenPaused: false,
    caseOutcome: undefined,
    reorgDetected: false,
    reorgBeyondLookback: false,
    evidenceBlocksComparable: true,
    policyVersion: '2026-09-07.1',
    openIncident: false,
    ...overrides,
  };
}

describe('the transition table', () => {
  it('has an entry for every state', () => {
    for (const state of B20_STATES) {
      expect(
        isLegalTransition(state, state) || allLegalB20Transitions().some((t) => t.from === state),
      ).toBe(true);
    }
  });

  it('rejects a jump from CONFLICT straight to VERIFIED', () => {
    // Recovery requires new evidence and a new transition. There is no path that edits a
    // state back to healthy, which is what makes the transition history worth reading.
    expect(isLegalTransition('CONFLICT', 'VERIFIED')).toBe(false);
    expect(isLegalTransition('CONFLICT', 'RECOVERING')).toBe(true);
    expect(isLegalTransition('RECOVERING', 'VERIFIED')).toBe(true);
  });

  it('lets nothing leave MANUAL_REVIEW except recovery', () => {
    const from = allLegalB20Transitions().filter((t) => t.from === 'MANUAL_REVIEW');
    expect(from.map((t) => t.to)).toEqual(['RECOVERING']);
  });

  it('throws rather than silently accepting an impossible transition', () => {
    // The machine is asked for a transition it cannot make when the caller's `from` is stale.
    // Failing loudly beats recording a state change that never legally happened.
    expect(() => nextB20State('MANUAL_REVIEW', healthy())).toThrow(IllegalTransitionError);
  });
});

describe('a reorg outranks every conclusion drawn from the replaced branch', () => {
  it('moves to REORGED even when everything else looks healthy', () => {
    const transition = nextB20State('NORMAL', healthy({ reorgDetected: true }));
    expect(transition.to).toBe('REORGED');
    expect(transition.reasons).toContain('B20_REORG_DETECTED');
    expect(transition.severity).toBe('SAFETY_CRITICAL');
  });

  it('escalates a reorg deeper than the retained lookback', () => {
    const transition = nextB20State('NORMAL', healthy({ reorgBeyondLookback: true }));
    expect(transition.to).toBe('MANUAL_REVIEW');
    expect(transition.reasons).toContain('B20_REORG_BEYOND_LOOKBACK');
  });
});

describe('identity comes before freshness', () => {
  it('sends a fixture to UNSUPPORTED, however healthy it looks', () => {
    const transition = nextB20State('DISCOVERED', healthy({ assetIsFixture: true }));
    expect(transition.to).toBe('UNSUPPORTED');
    expect(transition.reasons).toContain('B20_FIXTURE_NOT_PRODUCTION');
  });

  it('treats unestablished identity as missing evidence, not as a conflict', () => {
    const transition = nextB20State('DISCOVERED', healthy({ assetVerified: undefined }));
    expect(transition.to).toBe('INSUFFICIENT_EVIDENCE');
    expect(transition.reasons).toContain('B20_UNKNOWN_ASSET');
  });

  it('treats a failed verification as a conflict', () => {
    // Not knowing and knowing it is wrong are different problems with different responses.
    const transition = nextB20State('DISCOVERED', healthy({ assetVerified: false }));
    expect(transition.to).toBe('CONFLICT');
    expect(transition.reasons).toContain('B20_NOT_ON_OFFICIAL_LIST');
  });
});

describe('missing data never equals a match', () => {
  const cases: readonly {
    name: string;
    input: Partial<B20MachineInput>;
    reason: string;
  }[] = [
    { name: 'unreachable RPC', input: { rpcReachable: false }, reason: 'B20_RPC_UNAVAILABLE' },
    {
      name: 'evidence from incomparable blocks',
      input: { evidenceBlocksComparable: false },
      reason: 'B20_EVIDENCE_BLOCK_MISMATCH',
    },
    {
      name: 'unreviewed feed pairing',
      input: { feedPairingReviewed: false },
      reason: 'B20_FEED_PAIRING_UNREVIEWED',
    },
    {
      name: 'no feed round read',
      input: { feedVerdict: undefined },
      reason: 'B20_RPC_UNAVAILABLE',
    },
    { name: 'stale feed', input: { feedVerdict: 'STALE' }, reason: 'B20_FEED_STALE' },
    {
      name: 'expected weekend hold',
      input: { feedVerdict: 'EXPECTED_HOLD' },
      reason: 'B20_FEED_EXPECTED_HOLD',
    },
    {
      name: 'sequencer unavailable',
      input: { feedVerdict: 'SEQUENCER_UNAVAILABLE' },
      reason: 'B20_SEQUENCER_DOWN',
    },
    { name: 'issuer paused', input: { feedVerdict: 'ISSUER_PAUSED' }, reason: 'B20_ISSUER_PAUSED' },
    {
      name: 'invalid round',
      input: { feedVerdict: 'INVALID_ROUND' },
      reason: 'B20_FEED_INVALID_ROUND',
    },
    { name: 'token paused', input: { tokenPaused: true }, reason: 'B20_TOKEN_PAUSED' },
    { name: 'open incident', input: { openIncident: true }, reason: 'B20_MANUAL_REVIEW_REQUIRED' },
  ];

  for (const testCase of cases) {
    it(`never reaches VERIFIED with ${testCase.name}`, () => {
      const transition = nextB20State('RECONCILING', healthy(testCase.input));
      expect(transition.to).not.toBe('VERIFIED');
      expect(transition.reasons).toContain(testCase.reason);
    });
  }

  it('reaches VERIFIED only when every mandatory source is present and agrees', () => {
    const transition = nextB20State('RECONCILING', healthy());
    expect(transition.to).toBe('VERIFIED');
    expect(transition.reasons).toEqual([]);
  });
});

describe('the capability gate does not let the machine claim a clean bill of health', () => {
  it('carries UNSUPPORTED_CAPABILITY when the scheduling surface is not dialed', () => {
    // The live Base mainnet position. The asset is healthy in every observable respect, and
    // the machine still says out loud that it cannot see whether an action is coming.
    const transition = nextB20State(
      'NORMAL',
      healthy({ capabilityScheduledUpdates: 'NOT_DIALED' }),
    );
    expect(transition.to).toBe('NORMAL');
    expect(transition.reasons).toContain('B20_UNSUPPORTED_CAPABILITY');
    expect(transition.detail).toContain('not the same as none existing');
  });

  it('drops the caveat once the surface is live', () => {
    expect(nextB20State('NORMAL', healthy()).reasons).not.toContain('B20_UNSUPPORTED_CAPABILITY');
  });
});

describe('the guard window', () => {
  it('reports a distant schedule as pending', () => {
    const transition = nextB20State(
      'NORMAL',
      healthy({ pendingSchedule: { effectiveAtSeconds: NOW + 86_400n } }),
    );
    expect(transition.to).toBe('ACTION_PENDING');
    expect(transition.reasons).toContain('B20_SCHEDULE_NOT_YET_EFFECTIVE');
  });

  it('enters the guard window as activation approaches', () => {
    // Inside the window the multiplier is about to move, so any decision made now can be
    // wrong by the time it executes.
    const transition = nextB20State(
      'ACTION_PENDING',
      healthy({ pendingSchedule: { effectiveAtSeconds: NOW + 60n } }),
    );
    expect(transition.to).toBe('GUARD_WINDOW');
    expect(transition.severity).toBe('EVIDENCE_DEGRADED');
  });

  it('moves to ACTION_EFFECTIVE once the schedule has activated', () => {
    const transition = nextB20State(
      'GUARD_WINDOW',
      healthy({ pendingSchedule: { effectiveAtSeconds: NOW - 1n } }),
    );
    expect(transition.to).toBe('ACTION_EFFECTIVE');
  });
});

describe('the correlated case feeds the machine', () => {
  it('conflicts when correlation found contradictory evidence', () => {
    const transition = nextB20State('RECONCILING', healthy({ caseOutcome: 'CONFLICT' }));
    expect(transition.to).toBe('CONFLICT');
  });

  it('escalates a case that outran its SLA', () => {
    const transition = nextB20State('RECONCILING', healthy({ caseOutcome: 'MANUAL_REVIEW' }));
    expect(transition.to).toBe('MANUAL_REVIEW');
  });
});

describe('operational properties', () => {
  it('records the policy version on every transition', () => {
    // A policy change invalidates cached decisions, so the version has to travel with the
    // decision rather than being looked up later.
    expect(nextB20State('RECONCILING', healthy()).policyVersion).toBe('2026-09-07.1');
  });

  it('derives severity from the destination, never from a score', () => {
    expect(nextB20State('NORMAL', healthy({ reorgDetected: true })).severity).toBe(
      'SAFETY_CRITICAL',
    );
    expect(nextB20State('RECONCILING', healthy()).severity).toBe('INFORMATIONAL');
  });

  it('knows which states cannot move without new evidence', () => {
    expect(needsNewEvidence('VERIFIED')).toBe(true);
    expect(needsNewEvidence('CONFLICT')).toBe(true);
    expect(needsNewEvidence('OBSERVING')).toBe(false);
  });

  it('gives identical incidents one signature, ignoring time and block', () => {
    // Including the timestamp would defeat deduplication entirely: an operator would see 400
    // rows instead of one row that happened 400 times.
    const a = nextB20State('RECONCILING', healthy({ feedVerdict: 'STALE' }));
    const b = nextB20State(
      'RECONCILING',
      healthy({ feedVerdict: 'STALE', evaluateAtSeconds: NOW + 999n }),
    );
    expect(incidentSignature(8453, '0xabc', a)).toBe(incidentSignature(8453, '0xABC', b));
  });

  it('gives different reasons different signatures', () => {
    const stale = nextB20State('RECONCILING', healthy({ feedVerdict: 'STALE' }));
    const paused = nextB20State('RECONCILING', healthy({ feedVerdict: 'ISSUER_PAUSED' }));
    expect(incidentSignature(8453, '0xabc', stale)).not.toBe(
      incidentSignature(8453, '0xabc', paused),
    );
  });

  it('is deterministic: the same input always yields the same transition', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<B20State>('NORMAL', 'RECONCILING', 'OBSERVING', 'DISCOVERED'),
        fc.boolean(),
        fc.boolean(),
        (from, reorg, paused) => {
          const state = healthy({ reorgDetected: reorg, tokenPaused: paused });
          let first: string;
          try {
            first = JSON.stringify(nextB20State(from, state), replacer);
          } catch {
            return true;
          }
          const second = JSON.stringify(nextB20State(from, state), replacer);
          return first === second;
        },
      ),
    );
  });
});

const replacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;
