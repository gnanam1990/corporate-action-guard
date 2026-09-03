import { AppShell } from '@/components/app-shell';
import { EmptyState } from '@/components/primitives';

/**
 * Route placeholder.
 *
 * Exists so primary navigation resolves and typed routes compile. It renders no product
 * data: the real page is built in a later module, and a placeholder resembling live
 * evidence would be exactly the fake-runtime-data failure ADR 0003 forbids.
 */
export default function Page() {
  return (
    <AppShell
      environmentLabel="LIVE X LAYER MAINNET READS · TESTNET ENFORCEMENT"
      currentPath="/incidents"
    >
      <h1 style={{ fontSize: 'var(--text-xl)', margin: '0 0 var(--space-5)' }}>Incidents</h1>
      <EmptyState
        title="Not yet implemented"
        description="This route is a navigation target for the shell. Its live evidence view is built in a later module; no placeholder product data is shown here."
      />
    </AppShell>
  );
}
