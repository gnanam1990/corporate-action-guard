import Link from 'next/link';
import { AppShell, type SourceHealth } from '@/components/app-shell';
import { EmptyState, ErrorState, InlineAlert } from '@/components/primitives';
import { ReasonCode, StatusBadge, type StatusTone } from '@/components/status';
import { api, type Incident } from '@/lib/api';

/**
 * Incidents.
 *
 * Ordered by deterministic severity, then recency — an operator opening this must see the
 * most dangerous open incident first, not merely the newest.
 *
 * There is no numeric risk score anywhere on this page. Severity is one of three named
 * categories derived from the reason codes, because a number invites comparison it cannot
 * support: "risk 73" implies a precision the evidence does not have.
 */

export const dynamic = 'force-dynamic';

const SEVERITY_TONE: Record<Incident['severity'], StatusTone> = {
  SAFETY_CRITICAL: 'blocked',
  EVIDENCE_DEGRADED: 'pending',
  INPUT_REJECTED: 'unknown',
};

const STATUS_TONE: Record<Incident['status'], StatusTone> = {
  OPEN: 'blocked',
  IN_REVIEW: 'pending',
  RESOLVED: 'verified',
  RECOVERED: 'verified',
};

export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; assetId?: string }>;
}) {
  const filters = await searchParams;
  const [incidents, health] = await Promise.all([
    api.incidents({ status: filters.status, assetId: filters.assetId }),
    api.sourceHealth(),
  ]);

  const sources: readonly SourceHealth[] | undefined = health.ok
    ? health.data.sources.map((s) => ({ name: s.sourceKind, healthy: s.healthy, detail: s.detail }))
    : undefined;

  return (
    <AppShell
      environmentLabel="LIVE X LAYER MAINNET READS · TESTNET ENFORCEMENT"
      currentPath="/incidents"
      {...(sources === undefined ? {} : { sources })}
    >
      <header className="page-header">
        <h1 className="page-title">Incidents</h1>
        <p className="page-subtitle">
          Ordered by severity, then by how recently the condition was observed. Severity is a
          deterministic category derived from the reason codes — there is no numeric risk score.
        </p>
      </header>

      <form className="filters" method="get" role="search">
        <label className="filters__field">
          <span className="filters__label">Status</span>
          <select className="filters__input" name="status" defaultValue={filters.status ?? ''}>
            <option value="">Any</option>
            {['OPEN', 'IN_REVIEW', 'RESOLVED', 'RECOVERED'].map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="filters__field">
          <span className="filters__label">Asset</span>
          <input
            className="filters__input"
            type="search"
            name="assetId"
            defaultValue={filters.assetId ?? ''}
          />
        </label>
        <button className="filters__submit" type="submit">
          Apply
        </button>
      </form>

      {!incidents.ok ? (
        <ErrorState
          title="Incidents unavailable"
          description={`The incident list could not be read from the API (${incidents.detail}). An empty list is not shown in its place — no incidents and no answer are different things.`}
        />
      ) : incidents.data.items.length === 0 ? (
        <>
          <EmptyState
            title="No incidents"
            description="Nothing has been escalated. This means the reconciler has not recorded a mismatch, not that every asset is safe to act on — check the coverage view for per-asset state."
          />
          <div style={{ marginTop: 'var(--space-4)' }}>
            <InlineAlert tone="info" title="An empty incident list is not a clean bill of health.">
              An asset can be blocked without an incident: stale evidence, an unreachable source, or
              a guard window all refuse actions without escalating.
            </InlineAlert>
          </div>
        </>
      ) : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Incidents, scrollable">
          <table className="data-table">
            <caption className="visually-hidden">
              Incidents with severity, status, triggering reason codes, and the window over which
              the condition was observed.
            </caption>
            <thead>
              <tr>
                <th scope="col">Asset</th>
                <th scope="col">Severity</th>
                <th scope="col">Status</th>
                <th scope="col">Reasons</th>
                <th scope="col">First detected</th>
                <th scope="col">Last observed</th>
              </tr>
            </thead>
            <tbody>
              {incidents.data.items.map((incident) => (
                <tr key={incident.incidentId}>
                  <th scope="row" data-label="Asset">
                    <Link className="asset-link" href={{ pathname: `/assets/${incident.assetId}` }}>
                      {incident.assetId}
                    </Link>
                    <span className="asset-id mono">{incident.incidentId.slice(0, 8)}</span>
                  </th>
                  <td data-label="Severity">
                    <StatusBadge
                      tone={SEVERITY_TONE[incident.severity]}
                      label={incident.severity.replace(/_/g, ' ')}
                    />
                  </td>
                  <td data-label="Status">
                    <StatusBadge
                      tone={STATUS_TONE[incident.status]}
                      label={incident.status.replace(/_/g, ' ')}
                    />
                  </td>
                  <td data-label="Reasons">
                    <div className="reason-list">
                      {incident.reasonCodes.map((code) => (
                        <ReasonCode key={code} code={code} />
                      ))}
                    </div>
                  </td>
                  <td data-label="First detected" className="mono cell-detail">
                    {incident.firstDetectedAt}
                  </td>
                  <td data-label="Last observed" className="mono cell-detail">
                    {incident.lastObservedAt}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {incidents.ok && <p className="served-at mono">served at {incidents.data.servedAt}</p>}
    </AppShell>
  );
}
