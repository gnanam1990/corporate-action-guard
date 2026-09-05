import { AppShell } from '@/components/app-shell';
import { AssetTable } from '@/components/asset-table';
import { EmptyState, ErrorState, MetricCard } from '@/components/primitives';
import { StatusBadge } from '@/components/status';
import {
  api,
  type ApiResult,
  type AssetPage,
  type Coverage,
  type SourceHealthResponse,
} from '@/lib/api';
import { shellSources } from '@/lib/source-health';

/**
 * Coverage dashboard.
 *
 * Answers "what is protected, what is unsafe, and how fresh is the evidence?" without the
 * operator having to click anything.
 *
 * Fetched in a server component: the data is per-request and uncached, and no API base URL
 * or response body needs to travel to the browser to render the first paint. Every result
 * is a discriminated union, so an unreachable API renders a truthful unavailable state
 * rather than an empty table that looks like "nothing is wrong".
 */

export const dynamic = 'force-dynamic';

const API_STALE_AFTER_MS = 300_000;
const CHAIN_STALE_AFTER_MS = 120_000;

interface SearchParams {
  readonly lifecycleState?: string;
  readonly canonicality?: string;
  readonly search?: string;
  readonly cursor?: string;
}

export default async function CoveragePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const filters = await searchParams;

  // Fetched together so the metrics, the health strip, and the table describe the same
  // moment rather than three moments a few hundred milliseconds apart.
  const [coverage, health, assets] = await Promise.all([
    api.coverage(),
    api.sourceHealth(),
    api.assets({
      lifecycleState: filters.lifecycleState,
      canonicality: filters.canonicality,
      search: filters.search,
      cursor: filters.cursor,
      limit: '50',
    }),
  ]);

  const sources = shellSources(health);

  return (
    <AppShell
      environmentLabel="LIVE X LAYER MAINNET READS · TESTNET ENFORCEMENT"
      currentPath="/"
      {...(sources === undefined ? {} : { sources })}
    >
      <header className="page-header">
        <h1 className="page-title">Coverage</h1>
        <p className="page-subtitle">
          What is protected, what is unsafe, and how fresh the evidence behind each answer is.
        </p>
      </header>

      <Metrics coverage={coverage} />
      <SourceStrip health={health} />
      <Assets assets={assets} filters={filters} />
    </AppShell>
  );
}

function Metrics({ coverage }: { coverage: ApiResult<Coverage> }) {
  if (!coverage.ok) {
    return (
      <ErrorState
        title="Coverage metrics unavailable"
        description={`These counts could not be read from the API (${coverage.detail}). They are deliberately not shown as zero — zero and unknown are different answers.`}
      />
    );
  }

  const { discovered, canonicallyVerified, pendingOrGuardWindow, mismatchedOrReview, servedAt } =
    coverage.data;

  return (
    <section aria-labelledby="metrics-heading" className="metrics">
      <h2 id="metrics-heading" className="visually-hidden">
        Coverage summary
      </h2>
      <div className="metrics__grid">
        <MetricCard
          label="Discovered assets"
          value={String(discovered)}
          detail={`as of ${servedAt}`}
        />
        <MetricCard
          label="Canonically verified"
          value={String(canonicallyVerified)}
          tone="verified"
          detail={`${discovered - canonicallyVerified} not verified`}
        />
        <MetricCard
          label="Pending or in guard window"
          value={String(pendingOrGuardWindow)}
          tone="pending"
          detail="Protected actions refused inside the window"
        />
        <MetricCard
          label="Mismatched or in review"
          value={String(mismatchedOrReview)}
          tone="blocked"
          detail="Sources disagree; actions fail closed"
        />
      </div>
    </section>
  );
}

function SourceStrip({ health }: { health: ApiResult<SourceHealthResponse> }) {
  return (
    <section aria-labelledby="sources-heading" className="sources">
      <h2 id="sources-heading" className="section-title">
        Mandatory sources
      </h2>
      {!health.ok ? (
        <ErrorState
          title="Source health unavailable"
          description={`The console could not determine whether its evidence sources are healthy (${health.detail}). Treat everything on this page as unverified.`}
        />
      ) : health.data.sources.length === 0 ? (
        <EmptyState
          title="No source health recorded yet"
          description="The worker has not yet reported on any source. This is not the same as every source being healthy."
        />
      ) : (
        <ul className="sources__list">
          {health.data.sources.map((source) => (
            <li key={source.sourceKind} className="sources__item">
              <span className="sources__name">{source.sourceKind}</span>
              <StatusBadge
                tone={source.healthy ? 'verified' : 'blocked'}
                label={source.healthy ? 'HEALTHY' : 'DEGRADED'}
              />
              <span className="sources__detail mono">
                {source.healthy
                  ? `last success ${source.lastSuccessAt ?? 'never'}`
                  : `last failure ${source.lastFailureAt ?? 'unknown'}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Assets({ assets, filters }: { assets: ApiResult<AssetPage>; filters: SearchParams }) {
  const filtered =
    filters.lifecycleState !== undefined ||
    filters.canonicality !== undefined ||
    (filters.search !== undefined && filters.search !== '');

  return (
    <section aria-labelledby="assets-heading" className="assets">
      <h2 id="assets-heading" className="section-title">
        Assets
      </h2>

      {/* Filters are URL-addressable, so an operator can share the exact view they are
          looking at. A plain GET form keeps that true without any client JavaScript. */}
      <form className="filters" method="get" role="search">
        <label className="filters__field">
          <span className="filters__label">Search</span>
          <input
            className="filters__input"
            type="search"
            name="search"
            defaultValue={filters.search ?? ''}
            placeholder="Symbol or asset id"
          />
        </label>
        <label className="filters__field">
          <span className="filters__label">Lifecycle</span>
          <select
            className="filters__input"
            name="lifecycleState"
            defaultValue={filters.lifecycleState ?? ''}
          >
            <option value="">Any</option>
            {[
              'NORMAL',
              'PENDING',
              'GUARD_WINDOW',
              'APPLIED',
              'RECONCILED',
              'MISMATCH',
              'MANUAL_REVIEW',
              'RECOVERED',
            ].map((state) => (
              <option key={state} value={state}>
                {state.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="filters__field">
          <span className="filters__label">Canonicality</span>
          <select
            className="filters__input"
            name="canonicality"
            defaultValue={filters.canonicality ?? ''}
          >
            <option value="">Any</option>
            <option value="PASS">PASS</option>
            <option value="FAIL">FAIL</option>
            <option value="UNKNOWN">UNKNOWN</option>
          </select>
        </label>
        <button className="filters__submit" type="submit">
          Apply
        </button>
      </form>

      {!assets.ok ? (
        <ErrorState
          title="Assets unavailable"
          description={`The asset catalog could not be read from the API (${assets.detail}). No cached or sample data is shown in its place.`}
        />
      ) : assets.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No assets match these filters' : 'No assets discovered yet'}
          description={
            filtered
              ? 'Clear or widen the filters to see the full catalog.'
              : 'The worker has not yet discovered any assets from the xStocks API. An empty catalog is reported as empty, never filled with placeholder rows.'
          }
        />
      ) : (
        <>
          <AssetTable
            assets={assets.data.items}
            apiStaleAfterMs={API_STALE_AFTER_MS}
            chainStaleAfterMs={CHAIN_STALE_AFTER_MS}
          />
          <p className="served-at mono">served at {assets.data.servedAt}</p>
        </>
      )}
    </section>
  );
}
