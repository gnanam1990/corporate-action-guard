import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadEnv,
  PUBLIC_KEYS,
  SERVER_SECRET_KEYS,
  XLAYER_MAINNET_CHAIN_ID,
  XLAYER_TESTNET_CHAIN_ID,
} from '../src/index.js';

const base = { DATABASE_URL: 'postgresql://guard:guard@localhost:5432/guard' };

describe('loadEnv', () => {
  it('applies documented defaults', () => {
    const env = loadEnv({ ...base });
    expect(env.NODE_ENV).toBe('development');
    expect(env.XSTOCKS_API_BASE_URL).toBe('https://api.xstocks.fi/api/v2');
    expect(env.XLAYER_MAINNET_CHAIN_ID).toBe(XLAYER_MAINNET_CHAIN_ID);
    expect(env.XLAYER_TESTNET_CHAIN_ID).toBe(XLAYER_TESTNET_CHAIN_ID);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(ConfigError);
  });

  it('reports every problem, not just the first', () => {
    try {
      loadEnv({ ...base, XSTOCKS_API_BASE_URL: 'not-a-url', RECEIPT_SIGNER_ADDRESS: '0xzz' });
      expect.unreachable('expected ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('treats empty strings as absent, matching .env.example', () => {
    const env = loadEnv({
      ...base,
      RECEIPT_SIGNER_PRIVATE_KEY: '',
      GUARD_ADAPTER_TESTNET_ADDRESS: '',
    });
    expect(env.RECEIPT_SIGNER_PRIVATE_KEY).toBeUndefined();
    expect(env.GUARD_ADAPTER_TESTNET_ADDRESS).toBeUndefined();
  });

  it('rejects a malformed private key rather than coercing it', () => {
    expect(() => loadEnv({ ...base, RECEIPT_SIGNER_PRIVATE_KEY: '0xdeadbeef' })).toThrow(
      ConfigError,
    );
  });

  it('pins the X Layer mainnet chain id to 196', () => {
    expect(() => loadEnv({ ...base, XLAYER_MAINNET_CHAIN_ID: '1' })).toThrow(ConfigError);
  });

  it('pins the X Layer testnet chain id to 1952', () => {
    expect(() => loadEnv({ ...base, XLAYER_TESTNET_CHAIN_ID: '11155111' })).toThrow(ConfigError);
  });
});

describe('browser-bundle secret boundary', () => {
  it('rejects an unknown NEXT_PUBLIC_ variable', () => {
    expect(() => loadEnv({ ...base, NEXT_PUBLIC_RECEIPT_SIGNER_PRIVATE_KEY: '0x00' })).toThrow(
      ConfigError,
    );
  });

  it('allows only the declared public keys through the prefix', () => {
    const env = loadEnv({ ...base, NEXT_PUBLIC_API_BASE_URL: 'http://localhost:4000' });
    expect(env.NEXT_PUBLIC_API_BASE_URL).toBe('http://localhost:4000');
  });

  it('no declared server secret carries the public prefix', () => {
    for (const key of SERVER_SECRET_KEYS) {
      expect(String(key).startsWith('NEXT_PUBLIC_')).toBe(false);
    }
  });

  it('the public allowlist and the secret list are disjoint', () => {
    const publics = new Set<string>(PUBLIC_KEYS as readonly string[]);
    for (const key of SERVER_SECRET_KEYS) {
      expect(publics.has(String(key))).toBe(false);
    }
  });
});
