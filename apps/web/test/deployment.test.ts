import { describe, expect, it } from 'vitest';
import { parseDeployment, readDeployment } from '../src/lib/deployment';

describe('testnet deployment artifact', () => {
  it('loads the checked-in, current v2 deployment', () => {
    const deployment = readDeployment();
    expect(deployment).toBeDefined();
    expect(deployment?.chainId).toBe(1952);
    expect(deployment?.implementationVersion).toBe(2);
  });

  it('rejects an obsolete implementation', () => {
    expect(parseDeployment({ chainId: 1952, implementationVersion: 1 })).toBeUndefined();
  });

  it('rejects a partial artifact even when its version and chain look current', () => {
    expect(parseDeployment({ chainId: 1952, implementationVersion: 2 })).toBeUndefined();
  });
});
