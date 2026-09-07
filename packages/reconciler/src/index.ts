export {
  CURRENT_WRAPPER_VERSION,
  currentWrapperAddress,
  legacyWrapperAddress,
  verifyCanonicality,
  type CanonicalityInput,
  type CanonicalityRecord,
} from './canonicality.js';
export {
  diffRegistry,
  toRegistryEntry,
  type RegistryChange,
  type RegistryChangeKind,
  type RegistrySnapshotEntry,
} from './registry-diff.js';
export {
  canRecover,
  defaultPolicy,
  reasonSignature,
  reconcileAsset,
  type ReconcileDecision,
  type ReconcileInput,
  type ReconcileOutcome,
  type ReconcilePolicy,
} from './reconcile.js';

/* Base B20 — additive. See ADR 0005. */
export {
  B20_REGISTRY_CHANGE_KINDS,
  BASE_MAINNET_CHAIN_ID,
  diffB20Registry,
  ManifestError,
  parseB20AssetManifest,
  projectB20Registry,
  resolveB20Asset,
  type B20AssetManifest,
  type B20ManifestAsset,
  type B20RegistryChange,
  type B20RegistryChangeKind,
  type B20RegistryEntry,
} from './b20-registry.js';
