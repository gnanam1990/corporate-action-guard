/**
 * Base B20 configuration.
 *
 * The first test is the one that matters most: an existing X Layer deployment must start
 * unchanged after this package gained thirty Base variables. Everything else here is about
 * refusing to enable something because a string happens to be present.
 */
import { describe, expect, it } from 'vitest';
import {
  baseEnvSchema,
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SERVER_SECRET_KEYS,
  ConfigError,
  loadEnv,
  PUBLIC_KEYS,
  resolveB20Features,
  resolveBaseMainnetRead,
  resolveSepoliaWriteGate,
  SERVER_SECRET_KEYS,
  validateBaseEnv,
  type BaseEnv,
} from '../src/index.js';

/** A minimal environment for an X Layer deployment that knows nothing about Base. */
const X_LAYER_ONLY = {
  DATABASE_URL: 'postgres://localhost:5432/cag',
} as const;

const baseEnv = (overrides: Record<string, string> = {}): BaseEnv =>
  baseEnvSchema.parse({ ...overrides });

describe('an X Layer deployment is unaffected', () => {
  it('starts with no Base variable set at all', () => {
    const env = loadEnv({ ...X_LAYER_ONLY });
    expect(env.B20_READS_ENABLED).toBe(false);
    expect(env.BASE_MAINNET_RPC_URL).toBeUndefined();
    expect(env.BASE_MAINNET_CHAIN_ID).toBe(BASE_MAINNET_CHAIN_ID);
  });

  it('leaves every Base feature off by default', () => {
    // A deployment that upgrades for an unrelated reason must not acquire a half-built
    // Base surface.
    const features = resolveB20Features(baseEnv());
    expect(features.reads.enabled).toBe(false);
    expect(features.ledger.enabled).toBe(false);
    expect(features.preflight.enabled).toBe(false);
    expect(features.adapter.enabled).toBe(false);
  });
});

describe('Base mainnet is read-only by shape', () => {
  it('produces a read configuration with no signer field to fill in', () => {
    const config = resolveBaseMainnetRead(
      baseEnv({ B20_READS_ENABLED: 'true', BASE_MAINNET_RPC_URL: 'https://mainnet.base.org' }),
    );
    expect(config).toBeDefined();
    expect(config?.readOnly).toBe(true);
    expect(config?.chainId).toBe(8453);
    // The assertion that matters: there is nowhere to put a key. A guard can be deleted; a
    // missing field cannot.
    expect(Object.keys(config ?? {}).join(' ')).not.toMatch(/signer|key|wallet|private/i);
  });

  it('pins the mainnet chain id', () => {
    expect(() => baseEnv({ BASE_MAINNET_CHAIN_ID: '1' })).toThrow();
    expect(() => baseEnv({ BASE_SEPOLIA_CHAIN_ID: '11155111' })).toThrow();
  });

  it('reads nothing when the flag is off, even with an RPC configured', () => {
    expect(
      resolveBaseMainnetRead(baseEnv({ BASE_MAINNET_RPC_URL: 'https://mainnet.base.org' })),
    ).toBeUndefined();
  });
});

describe('the Sepolia write gate needs all five conditions', () => {
  const complete = {
    BASE_SEPOLIA_WRITES_ENABLED: 'true',
    BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
    BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
    B20_GUARD_ADAPTER_SEPOLIA_ADDRESS: `0x${'aa'.repeat(20)}`,
    B20_PROTECTED_VAULT_SEPOLIA_ADDRESS: `0x${'bb'.repeat(20)}`,
  };

  it('opens only when every condition holds', () => {
    const gate = resolveSepoliaWriteGate(baseEnv(complete), true);
    expect(gate.enabled).toBe(true);
    expect(gate.missing).toEqual([]);
    expect(gate.chainId).toBe(BASE_SEPOLIA_CHAIN_ID);
  });

  it('names which condition is missing rather than saying "disabled"', () => {
    // "Writes are disabled" with no reason is the message that makes people start deleting
    // checks until something works.
    const { BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY: _omitted, ...withoutSigner } = complete;
    const gate = resolveSepoliaWriteGate(baseEnv(withoutSigner), true);
    expect(gate.enabled).toBe(false);
    expect(gate.missing).toEqual(['SIGNER']);
  });

  it('refuses when the capability has not been verified live', () => {
    // Capability comes from a probe at a recorded block. No environment variable may assert
    // that a chain supports something.
    const gate = resolveSepoliaWriteGate(baseEnv(complete), false);
    expect(gate.enabled).toBe(false);
    expect(gate.missing).toEqual(['VERIFIED_CAPABILITY']);
  });

  it('refuses a half-deployed adapter/vault pair', () => {
    // A vault whose adapter is absent routes value through an unprotected path while looking
    // configured.
    const { B20_PROTECTED_VAULT_SEPOLIA_ADDRESS: _omitted, ...halfDeployed } = complete;
    const gate = resolveSepoliaWriteGate(baseEnv(halfDeployed), true);
    expect(gate.missing).toContain('DEPLOYMENT_MANIFEST');
  });

  it('is closed by default with nothing configured', () => {
    const gate = resolveSepoliaWriteGate(baseEnv(), false);
    expect(gate.enabled).toBe(false);
    expect(gate.missing).toHaveLength(5);
  });
});

describe('features refuse to enable on a flag alone', () => {
  it('will not enable reads without an RPC and a manifest', () => {
    expect(resolveB20Features(baseEnv({ B20_READS_ENABLED: 'true' })).reads).toEqual({
      enabled: false,
      blockedBy: 'BASE_MAINNET_RPC_URL is not set',
    });
    expect(
      resolveB20Features(
        baseEnv({ B20_READS_ENABLED: 'true', BASE_MAINNET_RPC_URL: 'https://mainnet.base.org' }),
      ).reads.blockedBy,
    ).toContain('B20_OFFICIAL_ASSET_MANIFEST_PATH');
  });

  it('will not enable the adapter without the preflight that issues its receipts', () => {
    // The adapter authorizes value movement. Enabling it without preflight would mean
    // enforcing a receipt nothing can issue.
    const features = resolveB20Features(
      baseEnv({
        B20_ADAPTER_ENABLED: 'true',
        B20_READS_ENABLED: 'true',
        BASE_MAINNET_RPC_URL: 'https://mainnet.base.org',
        B20_OFFICIAL_ASSET_MANIFEST_PATH: 'provenance/base-b20/asset-manifest.json',
      }),
    );
    expect(features.reads.enabled).toBe(true);
    expect(features.adapter.enabled).toBe(false);
    expect(features.adapter.blockedBy).toContain('preflight');
  });

  it('enables the full chain when every dependency is present', () => {
    const features = resolveB20Features(
      baseEnv({
        B20_READS_ENABLED: 'true',
        B20_LEDGER_ENABLED: 'true',
        B20_PREFLIGHT_ENABLED: 'true',
        B20_ADAPTER_ENABLED: 'true',
        BASE_MAINNET_RPC_URL: 'https://mainnet.base.org',
        B20_OFFICIAL_ASSET_MANIFEST_PATH: 'provenance/base-b20/asset-manifest.json',
        CHAINLINK_FEED_MANIFEST_PATH: 'provenance/base-b20/feed-manifest.json',
      }),
    );
    expect(features.reads.enabled).toBe(true);
    expect(features.ledger.enabled).toBe(true);
    expect(features.preflight.enabled).toBe(true);
    expect(features.adapter.enabled).toBe(true);
  });
});

describe('validation catches the misconfigurations that only bite during an outage', () => {
  it('rejects one endpoint serving both chains', () => {
    // Every "wrong chain" assertion would pass while evidence carried the wrong chain label.
    const issues = validateBaseEnv(
      baseEnv({
        BASE_MAINNET_RPC_URL: 'https://same.example',
        BASE_SEPOLIA_RPC_URL: 'https://same.example',
      }),
      'development',
    );
    expect(issues.join(' ')).toContain('must not be the same endpoint');
  });

  it('rejects a reorg lookback that cannot outrun the confirmation depth', () => {
    const issues = validateBaseEnv(
      baseEnv({ BASE_CONFIRMATIONS: '600', BASE_REORG_LOOKBACK_BLOCKS: '100' }),
      'development',
    );
    expect(issues.join(' ')).toContain('must exceed BASE_CONFIRMATIONS');
  });

  it('rejects a zero staleness window, which reads tight and is the loosest setting there is', () => {
    expect(() => baseEnv({ CHAINLINK_DEFAULT_STALE_AFTER_SECONDS: '0' })).toThrow();
    expect(() => baseEnv({ CHAINLINK_SEQUENCER_GRACE_SECONDS: '0' })).toThrow();
  });

  it('rejects a raw deployer key in production', () => {
    const issues = validateBaseEnv(
      baseEnv({ BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY: `0x${'11'.repeat(32)}` }),
      'production',
    );
    expect(issues.join(' ')).toContain('must not be set in production');
  });

  it('rejects writes enabled with no signer', () => {
    const issues = validateBaseEnv(baseEnv({ BASE_SEPOLIA_WRITES_ENABLED: 'true' }), 'development');
    expect(issues.join(' ')).toContain('no Sepolia signer is configured');
  });

  it('fails startup, listing every problem, rather than the first', () => {
    let caught: unknown;
    try {
      loadEnv({
        ...X_LAYER_ONLY,
        BASE_MAINNET_RPC_URL: 'https://same.example',
        BASE_SEPOLIA_RPC_URL: 'https://same.example',
        BASE_CONFIRMATIONS: '600',
        BASE_REORG_LOOKBACK_BLOCKS: '100',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).issues).toHaveLength(2);
  });

  it('never echoes a value, because an RPC URL carries its API key', () => {
    const secretUrl = 'https://base-mainnet.example/v2/super-secret-key';
    const issues = validateBaseEnv(
      baseEnv({ BASE_MAINNET_RPC_URL: secretUrl, BASE_SEPOLIA_RPC_URL: secretUrl }),
      'development',
    );
    expect(issues.join(' ')).not.toContain('super-secret-key');
  });
});

describe('browser bundle boundary', () => {
  it('marks every Base RPC and key as server-only', () => {
    for (const key of BASE_SERVER_SECRET_KEYS) {
      expect(SERVER_SECRET_KEYS as readonly string[]).toContain(key);
    }
  });

  it('adds no Base variable to the public allowlist', () => {
    // `NEXT_PUBLIC_API_BASE_URL` legitimately contains "BASE" and is not a Base B20 variable,
    // so this matches the actual key names rather than a substring.
    const baseKeys = new Set<string>([...Object.keys(baseEnvSchema.shape)]);
    expect((PUBLIC_KEYS as readonly string[]).filter((k) => baseKeys.has(k))).toEqual([]);
    expect(
      (PUBLIC_KEYS as readonly string[]).filter(
        (k) => k.startsWith('NEXT_PUBLIC_BASE_') || k.startsWith('NEXT_PUBLIC_B20_'),
      ),
    ).toEqual([]);
  });

  it('refuses to start if a Base secret is given the NEXT_PUBLIC_ prefix', () => {
    expect(() =>
      loadEnv({ ...X_LAYER_ONLY, NEXT_PUBLIC_BASE_MAINNET_RPC_URL: 'https://mainnet.base.org' }),
    ).toThrow(ConfigError);
  });
});
