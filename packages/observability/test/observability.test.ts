import { describe, expect, it } from 'vitest';
import { createLogger, MetricsRegistry, redact, redactUrl, REDACTED } from '../src/index.js';

/** Canary values. If any of these ever appears in output, redaction has a hole. */
const CANARY = {
  privateKey: `0x${'ab'.repeat(32)}`,
  apiKey: 'sk_live_abcdefghijklmnop',
  bearer: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  rpcWithKey: 'https://rpc.example.com/v2/abcdefghijklmnopqrstuvwxyz012345',
  rpcWithUserinfo: 'https://user:hunter2@rpc.example.com/',
} as const;

describe('redaction', () => {
  it('redacts by key name', () => {
    const out = redact({ privateKey: 'x', apiKey: 'y', authorization: 'z', cookie: 'c' }) as Record<
      string,
      unknown
    >;
    expect(out['privateKey']).toBe(REDACTED);
    expect(out['apiKey']).toBe(REDACTED);
    expect(out['authorization']).toBe(REDACTED);
    expect(out['cookie']).toBe(REDACTED);
  });

  it('redacts snake_case and kebab-case variants', () => {
    const out = redact({ private_key: 'x', 'api-key': 'y', seed_phrase: 'z' }) as Record<
      string,
      unknown
    >;
    expect(Object.values(out)).toEqual([REDACTED, REDACTED, REDACTED]);
  });

  it('redacts by value shape even under an innocent key name', () => {
    // A secret usually reaches a log through a field nobody considered.
    const out = redact({
      note: CANARY.privateKey,
      header: CANARY.bearer,
      id: CANARY.apiKey,
    }) as Record<string, unknown>;
    expect(out['note']).toBe(REDACTED);
    expect(out['header']).toBe(REDACTED);
    expect(out['id']).toBe(REDACTED);
  });

  it('redacts nested and array-nested secrets', () => {
    const out = JSON.stringify(redact({ a: { b: [{ privateKey: CANARY.privateKey }] } }));
    expect(out).not.toContain('abab');
  });

  it('strips userinfo from a URL', () => {
    expect(redactUrl(CANARY.rpcWithUserinfo)).not.toContain('hunter2');
  });

  it('strips a key embedded in an RPC URL path', () => {
    // Many providers put the key in the path rather than a query parameter.
    expect(redactUrl(CANARY.rpcWithKey)).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
  });

  it('never throws on an unparseable URL', () => {
    expect(redactUrl('not a url')).toBe('[unparseable-url]');
  });

  it('bounds an unbounded string rather than logging megabytes', () => {
    const out = redact({ body: 'x'.repeat(10_000) }) as Record<string, string>;
    expect(out['body']!.length).toBeLessThan(2_100);
    expect(out['body']).toContain('[truncated]');
  });

  it('bounds a huge array', () => {
    const out = redact({ items: Array.from({ length: 5_000 }, (_, i) => i) }) as Record<
      string,
      unknown[]
    >;
    expect(out['items']!.length).toBeLessThanOrEqual(101);
  });

  it('does not blow up on a deeply nested structure', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 50; i++) nested = { nested };
    expect(() => redact(nested)).not.toThrow();
  });

  it('serialises bigint rather than throwing', () => {
    expect(redact({ amount: 10n })).toEqual({ amount: '10' });
  });
});

describe('logger', () => {
  const capture = () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: 'test',
      level: 'debug',
      sink: (l) => lines.push(l),
      clock: () => 0,
    });
    return { logger, lines };
  };

  it('emits structured JSON with service and level', () => {
    const { logger, lines } = capture();
    logger.info('hello', { correlationId: 'cid-1' });
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed['level']).toBe('info');
    expect(parsed['service']).toBe('test');
    expect(parsed['correlationId']).toBe('cid-1');
  });

  it('redacts every canary secret passed through context', () => {
    const { logger, lines } = capture();
    logger.error('boom', { ...CANARY });
    const output = lines.join('');
    for (const [name, value] of Object.entries(CANARY)) {
      if (name.startsWith('rpc')) continue;
      expect(output, `${name} leaked into the log`).not.toContain(value);
    }
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
  });

  it('respects the minimum level', () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: 't',
      level: 'warn',
      sink: (l) => lines.push(l),
      clock: () => 0,
    });
    logger.debug('no');
    logger.info('no');
    logger.warn('yes');
    expect(lines).toHaveLength(1);
  });

  it('a child logger carries bound context and redacts it too', () => {
    const { logger, lines } = capture();
    logger.child({ assetId: 'AAPLx', apiKey: CANARY.apiKey }).info('child');
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed['assetId']).toBe('AAPLx');
    expect(parsed['apiKey']).toBe(REDACTED);
  });
});

describe('metrics', () => {
  const registry = () => {
    const r = new MetricsRegistry();
    r.register({
      name: 'cag_requests_total',
      help: 'requests',
      type: 'counter',
      labelNames: ['route', 'status'],
    });
    r.register({
      name: 'cag_request_duration_seconds',
      help: 'latency',
      type: 'histogram',
      labelNames: ['route'],
      buckets: [0.01, 0.1, 1],
    });
    return r;
  };

  it('counts and renders in Prometheus format', () => {
    const r = registry();
    r.increment('cag_requests_total', { route: '/v1/assets', status: '200' });
    r.increment('cag_requests_total', { route: '/v1/assets', status: '200' });
    const out = r.render();
    expect(out).toContain('# TYPE cag_requests_total counter');
    expect(out).toContain('cag_requests_total{route="/v1/assets",status="200"} 2');
  });

  it('renders label order deterministically', () => {
    const r = registry();
    r.increment('cag_requests_total', { status: '200', route: '/a' });
    expect(r.render()).toContain('{route="/a",status="200"}');
  });

  it('observes into histogram buckets', () => {
    const r = registry();
    r.observe('cag_request_duration_seconds', 0.05, { route: '/v1/assets' });
    const out = r.render();
    expect(out).toContain('le="0.1"} 1');
    expect(out).toContain('le="0.01"} 0');
    expect(out).toContain('le="+Inf"} 1');
  });

  it('refuses an unbounded label rather than exploding cardinality', () => {
    // A metric labelled with a request id produces one series per request and takes down
    // the metrics backend instead of the service.
    const r = registry();
    expect(() => {
      for (let i = 0; i < 500; i++) {
        r.increment('cag_requests_total', { route: `/v1/assets/${i}`, status: '200' });
      }
    }).toThrow(/unbounded/i);
  });

  it('allows repeated use of an already-seen label set', () => {
    const r = registry();
    for (let i = 0; i < 10_000; i++) {
      r.increment('cag_requests_total', { route: '/v1/assets', status: '200' });
    }
    expect(r.cardinality('cag_requests_total')).toBe(1);
  });
});

/**
 * Regression: `api-key` was not matched while `api_key` was. Headers arrive kebab-cased
 * far more often than snake-cased, so the hole was exactly where headers get logged.
 */
describe('redaction key-name separators', () => {
  const variants = [
    'api-key',
    'api_key',
    'apikey',
    'API-KEY',
    'private-key',
    'private_key',
    'privatekey',
    'seed-phrase',
    'seed_phrase',
    'x-api-key',
    'x_auth_token',
    'set-cookie',
  ];

  for (const key of variants) {
    it(`redacts "${key}"`, () => {
      const out = redact({ [key]: 'leaked-value' }) as Record<string, unknown>;
      expect(out[key], `${key} was not redacted`).toBe(REDACTED);
    });
  }

  it('does not redact an innocent key that merely contains a substring', () => {
    const out = redact({ tokenomics: 'fine', description: 'fine' }) as Record<string, unknown>;
    expect(out['tokenomics']).toBe('fine');
    expect(out['description']).toBe('fine');
  });
});
