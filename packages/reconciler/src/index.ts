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
