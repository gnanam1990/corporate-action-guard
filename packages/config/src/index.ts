export {
  envSchema,
  PUBLIC_KEYS,
  SERVER_SECRET_KEYS,
  XLAYER_MAINNET_CHAIN_ID,
  XLAYER_TESTNET_CHAIN_ID,
  type Env,
} from './schema.js';
export {
  assertApiSignerConfig,
  ConfigError,
  getEnv,
  loadEnv,
  resetEnvCacheForTests,
} from './load.js';

/* Base B20 — additive. Nothing above changes shape or behaviour. See ADR 0005. */
export {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SERVER_SECRET_KEYS,
  SEPOLIA_WRITE_CONDITIONS,
  baseEnvSchema,
  resolveB20Features,
  resolveBaseMainnetRead,
  resolveSepoliaWriteGate,
  validateBaseEnv,
  type B20FeatureState,
  type BaseEnv,
  type BaseMainnetReadConfig,
  type SepoliaWriteCondition,
  type SepoliaWriteGate,
} from './base-b20.js';
