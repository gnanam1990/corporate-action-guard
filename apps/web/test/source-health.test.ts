import { describe, expect, it } from 'vitest';
import { shellSources } from '../src/lib/source-health.js';

describe('shell source health mapping', () => {
  it('preserves each API source and its health state', () => {
    expect(
      shellSources({
        ok: true,
        data: {
          servedAt: '2026-09-05T00:00:00.000Z',
          sources: [
            {
              sourceKind: 'XSTOCKS_API',
              healthy: true,
              lastSuccessAt: '2026-09-05T00:00:00.000Z',
              lastFailureAt: null,
              detail: '726 assets discovered',
            },
          ],
        },
      }),
    ).toEqual([{ name: 'XSTOCKS_API', healthy: true, detail: '726 assets discovered' }]);
  });

  it('keeps a failed health read unknown instead of manufacturing healthy sources', () => {
    expect(shellSources({ ok: false, reason: 'UNAVAILABLE', detail: 'connection failed' })).toBe(
      undefined,
    );
  });
});
