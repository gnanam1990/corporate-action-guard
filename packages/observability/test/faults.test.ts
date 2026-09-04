import { describe, expect, it } from 'vitest';
import {
  assertFaultsAllowed,
  FAULT_EXPECTATIONS,
  FAULT_KINDS,
  FaultInjector,
  FaultsNotAllowedError,
} from '../src/index.js';

describe('fault injection cannot reach production', () => {
  it('refuses to construct when NODE_ENV is production', () => {
    // On the constructor, not per call: a production process carrying a stray FAULTS=
    // variable must fail at startup rather than misbehave quietly under load.
    expect(() => new FaultInjector({ kinds: ['RPC_TIMEOUT'], nodeEnv: 'production' })).toThrow(
      FaultsNotAllowedError,
    );
  });

  it('the guard is a plain assertion anyone can read', () => {
    expect(() => assertFaultsAllowed('production')).toThrow(FaultsNotAllowedError);
    expect(() => assertFaultsAllowed('development')).not.toThrow();
    expect(() => assertFaultsAllowed('test')).not.toThrow();
    expect(() => assertFaultsAllowed(undefined)).not.toThrow();
  });

  it('says plainly that it is not configurable', () => {
    try {
      assertFaultsAllowed('production');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/not configurable/i);
    }
  });
});

describe('determinism', () => {
  it('the same seed produces the same sequence', () => {
    const a = new FaultInjector({
      kinds: ['RPC_TIMEOUT'],
      probability: 0.5,
      seed: 42,
      nodeEnv: 'test',
    });
    const b = new FaultInjector({
      kinds: ['RPC_TIMEOUT'],
      probability: 0.5,
      seed: 42,
      nodeEnv: 'test',
    });
    const seqA = Array.from({ length: 20 }, () => a.shouldFail('RPC_TIMEOUT'));
    const seqB = Array.from({ length: 20 }, () => b.shouldFail('RPC_TIMEOUT'));
    expect(seqB).toEqual(seqA);
  });

  it('a different seed produces a different sequence', () => {
    const a = new FaultInjector({
      kinds: ['RPC_TIMEOUT'],
      probability: 0.5,
      seed: 1,
      nodeEnv: 'test',
    });
    const b = new FaultInjector({
      kinds: ['RPC_TIMEOUT'],
      probability: 0.5,
      seed: 2,
      nodeEnv: 'test',
    });
    const seqA = Array.from({ length: 20 }, () => a.shouldFail('RPC_TIMEOUT'));
    const seqB = Array.from({ length: 20 }, () => b.shouldFail('RPC_TIMEOUT'));
    expect(seqB).not.toEqual(seqA);
  });

  it('probability 1 always fires; an inactive kind never does', () => {
    const injector = new FaultInjector({ kinds: ['SIGNER_TIMEOUT'], seed: 7, nodeEnv: 'test' });
    expect(injector.shouldFail('SIGNER_TIMEOUT')).toBe(true);
    expect(injector.shouldFail('RPC_TIMEOUT')).toBe(false);
  });

  it('counts what it triggered, so a scenario can assert it actually ran', () => {
    const injector = new FaultInjector({ kinds: ['RPC_TIMEOUT'], seed: 3, nodeEnv: 'test' });
    injector.shouldFail('RPC_TIMEOUT');
    injector.shouldFail('RPC_TIMEOUT');
    expect(injector.timesTriggered('RPC_TIMEOUT')).toBe(2);
  });

  it('maybeThrow raises the caller-supplied error at an I/O boundary', () => {
    const injector = new FaultInjector({
      kinds: ['DATABASE_UNAVAILABLE'],
      seed: 1,
      nodeEnv: 'test',
    });
    expect(() =>
      injector.maybeThrow('DATABASE_UNAVAILABLE', () => new Error('simulated outage')),
    ).toThrow('simulated outage');
  });
});

describe('environment parsing', () => {
  it('returns undefined when unset, so the harness is off by default', () => {
    expect(FaultInjector.fromEnv(undefined)).toBeUndefined();
    expect(FaultInjector.fromEnv('')).toBeUndefined();
  });

  it('parses a comma-separated list', () => {
    const injector = FaultInjector.fromEnv('RPC_TIMEOUT, SIGNER_TIMEOUT');
    expect(injector?.activeKinds().sort()).toEqual(['RPC_TIMEOUT', 'SIGNER_TIMEOUT']);
  });

  it('rejects an unknown fault name loudly rather than ignoring it', () => {
    // A typo that silently disables a scenario makes the harness worse than useless: the
    // run reports success having tested nothing.
    expect(() => FaultInjector.fromEnv('RPC_TIMEOOUT')).toThrow(/unknown fault kind/i);
  });
});

/**
 * A harness that only injects failures proves nothing. Each fault must declare what the
 * system is required to do, and every declared fault must have one.
 */
describe('every fault declares its required outcome', () => {
  it('covers every fault kind', () => {
    for (const kind of FAULT_KINDS) {
      expect(FAULT_EXPECTATIONS[kind], `${kind} has no expectation`).toBeDefined();
      expect(FAULT_EXPECTATIONS[kind].kind).toBe(kind);
    }
  });

  it('every expectation names a state, evidence, an operator view, and a recovery condition', () => {
    for (const kind of FAULT_KINDS) {
      const e = FAULT_EXPECTATIONS[kind];
      expect(e.expectedState.length, `${kind} state`).toBeGreaterThan(5);
      expect(e.expectedEvidence.length, `${kind} evidence`).toBeGreaterThan(5);
      expect(e.expectedOperatorView.length, `${kind} operator view`).toBeGreaterThan(5);
      expect(e.recoveryCondition.length, `${kind} recovery`).toBeGreaterThan(5);
    }
  });

  it('every source-unavailability fault fails closed with a block reason', () => {
    // These are the faults that must never let an action through.
    for (const kind of [
      'XSTOCKS_TIMEOUT',
      'RPC_TIMEOUT',
      'RPC_WRONG_CHAIN',
      'XSTOCKS_STALE_RESPONSE',
    ] as const) {
      expect(FAULT_EXPECTATIONS[kind].expectedBlockReason, `${kind} must block`).toBeDefined();
    }
  });

  it('no fault expects the system to authorize something', () => {
    // There is no failure mode whose correct response is to let an action through.
    //
    // Matching on the substring "receipt issued" was the naive version of this test, and
    // it failed against the expectation "no receipt issued" — the exact opposite of what
    // it meant to catch. Match affirmative phrasing only.
    const AUTHORIZES =
      /\b(?:a receipt is issued|receipt issued successfully|decision is ALLOW|permits the action)\b/i;
    for (const kind of FAULT_KINDS) {
      const text = JSON.stringify(FAULT_EXPECTATIONS[kind]);
      expect(text, `${kind} expects authorization`).not.toMatch(AUTHORIZES);
    }
  });

  it('the signer faults explicitly forbid a placeholder receipt', () => {
    // The positive form of the rule above: for the two faults where a caller might expect
    // a degraded-but-usable answer, the expectation says outright that none is produced.
    expect(FAULT_EXPECTATIONS.SIGNER_TIMEOUT.expectedEvidence).toMatch(/No RECEIPT_ISSUED/);
    expect(FAULT_EXPECTATIONS.SIGNER_UNKNOWN_OUTCOME.expectedEvidence).toMatch(/No RECEIPT_ISSUED/);
  });

  it('the reorg fault requires history to be retained', () => {
    expect(FAULT_EXPECTATIONS.RPC_REORG.expectedEvidence).toMatch(/NOT deleted/);
  });

  it('the signer faults never assume success', () => {
    expect(FAULT_EXPECTATIONS.SIGNER_TIMEOUT.expectedOperatorView).toMatch(/no placeholder/i);
    expect(FAULT_EXPECTATIONS.SIGNER_UNKNOWN_OUTCOME.expectedState).toMatch(
      /never assumed successful/i,
    );
  });
});
