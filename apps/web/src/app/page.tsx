import { AppShell } from '@/components/app-shell';
import { EmptyState, MetricCard } from '@/components/primitives';
import { EvidenceAge, ReasonCode, StatusBadge } from '@/components/status';

/**
 * Foundation page.
 *
 * Renders the shell and the primitives against DECLARED placeholder text only. There is
 * deliberately no asset list, metric value, balance, health value, or transaction hash
 * here — live evidence routes arrive in later modules, and a placeholder that looked like
 * product data would be exactly the fake-runtime-data failure ADR 0003 forbids.
 */
export default function HomePage() {
  return (
    <AppShell
      environmentLabel="LIVE X LAYER MAINNET READS · TESTNET ENFORCEMENT"
      // Undefined, not an empty array: health is genuinely not known here, and the shell
      // renders that as unknown rather than healthy.
      currentPath="/"
    >
      <h1 style={{ fontSize: 'var(--text-xl)', margin: '0 0 var(--space-2)' }}>Coverage</h1>
      <p style={{ color: 'var(--text-muted)', margin: '0 0 var(--space-5)', maxWidth: '70ch' }}>
        The design system and application shell are in place. Live asset coverage, source health,
        and incidents are served from the API in later modules; nothing on this page is product
        data.
      </p>

      <section aria-labelledby="primitives-heading">
        <h2 id="primitives-heading" style={{ fontSize: 'var(--text-lg)' }}>
          Status vocabulary
        </h2>
        <p style={{ color: 'var(--text-muted)', maxWidth: '70ch' }}>
          Every status carries a colour, a distinct glyph shape, and a text label. None of them
          relies on colour alone.
        </p>
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            flexWrap: 'wrap',
            margin: 'var(--space-4) 0',
          }}
        >
          <StatusBadge tone="verified" label="VERIFIED" />
          <StatusBadge tone="pending" label="GUARD WINDOW" />
          <StatusBadge tone="blocked" label="BLOCKED" />
          <StatusBadge tone="chain" label="CHAIN EVIDENCE" />
          <StatusBadge tone="unknown" label="UNKNOWN" />
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(13rem, 1fr))',
            gap: 'var(--space-4)',
            margin: 'var(--space-5) 0',
          }}
        >
          <MetricCard label="Discovered assets" value="—" detail="Awaiting the API" />
          <MetricCard
            label="Canonically verified"
            value="—"
            tone="verified"
            detail="Awaiting the API"
          />
          <MetricCard
            label="Pending or in guard window"
            value="—"
            tone="pending"
            detail="Awaiting the API"
          />
          <MetricCard label="Mismatched" value="—" tone="blocked" detail="Awaiting the API" />
        </div>

        <div
          style={{
            display: 'flex',
            gap: 'var(--space-3)',
            alignItems: 'flex-start',
            flexWrap: 'wrap',
          }}
        >
          <EvidenceAge ageMs={undefined} staleAfterMs={300_000} observedAtIso={undefined} />
          <ReasonCode
            code="SOURCE_MISMATCH"
            explanation="The API and on-chain observations disagree."
          />
          <ReasonCode code="ACTIVATION_WINDOW" />
        </div>

        <div style={{ marginTop: 'var(--space-6)' }}>
          <EmptyState
            title="No live data yet"
            description="Asset coverage, source health, and incidents are served from the API. This page renders no placeholder product data by design."
          />
        </div>
      </section>
    </AppShell>
  );
}
