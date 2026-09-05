import { AppShell } from '@/components/app-shell';
import { EmptyState } from '@/components/primitives';
import { api } from '@/lib/api';
import { shellSources } from '@/lib/source-health';

/**
 * A deep link to an asset that does not exist gets a clear removed state, not an empty
 * shell that looks like an asset with no evidence.
 */
export default async function AssetNotFound() {
  const sources = shellSources(await api.sourceHealth());
  return (
    <AppShell
      environmentLabel="LIVE X LAYER MAINNET READS · TESTNET ENFORCEMENT"
      currentPath="/"
      {...(sources === undefined ? {} : { sources })}
    >
      <EmptyState
        title="No such asset"
        description="This asset is not present in the discovered catalog. It may have been removed from the registry, or the identifier may be wrong. A removal is recorded as evidence rather than applied silently — check the incidents view."
      />
    </AppShell>
  );
}
