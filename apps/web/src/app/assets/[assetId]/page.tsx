import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { CopyButton } from '@/components/copy-button';
import { truncateAddress } from '@/components/format';
import { AddressLink } from '@/components/links';
import { ErrorState, InlineAlert } from '@/components/primitives';
import { EvidenceAge, outcomeTone, ReasonCode, StatusBadge } from '@/components/status';
import { ComparisonMatrix, EvidenceTimeline } from '@/components/timeline';
import { api, formatMultiplier, lifecycleTone, type Asset } from '@/lib/api';
import { shellSources } from '@/lib/source-health';

/**
 * Asset detail.
 *
 * The purpose is auditability: everything shown states where it came from, at which block,
 * and how old it is. Nothing is inferred. A field the evidence does not contain is shown as
 * absent rather than filled with a plausible value.
 */

export const dynamic = 'force-dynamic';

const API_STALE_AFTER_MS = 300_000;
const CHAIN_STALE_AFTER_MS = 120_000;

export default async function AssetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ assetId: string }>;
  searchParams: Promise<{ upToEventId?: string }>;
}) {
  const { assetId } = await params;
  const { upToEventId } = await searchParams;

  // Fetched together, so the header and the timeline describe the same moment.
  const [result, timeline, health] = await Promise.all([
    api.asset(assetId),
    api.timeline(assetId, upToEventId),
    api.sourceHealth(),
  ]);
  const sources = shellSources(health);

  if (!result.ok && result.reason === 'NOT_FOUND') notFound();

  return (
    <AppShell
      environmentLabel="LIVE X LAYER MAINNET READS · TESTNET ENFORCEMENT"
      currentPath="/"
      {...(sources === undefined ? {} : { sources })}
    >
      {!result.ok ? (
        <ErrorState
          title="Asset evidence unavailable"
          description={`The evidence for ${assetId} could not be read from the API (${result.detail}). No cached or partial state is shown in its place.`}
        />
      ) : (
        <>
          <AssetDetail asset={result.data} />

          <section aria-labelledby="comparison-heading" className="detail-section">
            <h2 id="comparison-heading" className="section-title">
              Source comparison
            </h2>
            {result.data.comparisonFields === null ? (
              <InlineAlert tone="warning" title="These sources have never been compared.">
                Never compared is not the same as compared-and-agreed. Protected actions are refused
                until a complete observation of both sources exists.
              </InlineAlert>
            ) : (
              <>
                <ComparisonMatrix fields={[...result.data.comparisonFields]} />
                <p className="detail-note">
                  Compared at {result.data.comparedAt ?? 'unknown'}. Agreement is scored only over
                  fields both sources are contractually expected to expose; a chain-authoritative
                  field is shown for visibility but does not contribute to the verdict.
                </p>
              </>
            )}
          </section>

          <section aria-labelledby="timeline-heading" className="detail-section">
            <h2 id="timeline-heading" className="section-title">
              Evidence timeline
            </h2>
            <p className="detail-note" style={{ marginTop: 0, marginBottom: 'var(--space-4)' }}>
              Replayed from immutable journal rows. No live source is consulted — a replay that
              called one would be a fresh observation wearing a historical label.
            </p>
            {!timeline.ok ? (
              <ErrorState
                title="Timeline unavailable"
                description={`The evidence journal could not be read (${timeline.detail}).`}
              />
            ) : (
              <EvidenceTimeline timeline={timeline.data} />
            )}
          </section>
        </>
      )}
    </AppShell>
  );
}

function AssetDetail({ asset }: { asset: Asset }) {
  const ageOf = (iso: string | null): number | undefined => {
    if (iso === null) return undefined;
    const parsed = Date.parse(iso);
    return Number.isNaN(parsed) ? undefined : Math.max(0, Date.now() - parsed);
  };

  return (
    <>
      <header className="page-header">
        <div className="detail-title-row">
          <h1 className="page-title">{asset.symbol}</h1>
          <StatusBadge
            tone={lifecycleTone(asset.lifecycleState)}
            label={asset.lifecycleState.replace(/_/g, ' ')}
          />
          <StatusBadge
            tone={outcomeTone(asset.canonicality)}
            label={`CANONICALITY ${asset.canonicality}`}
          />
        </div>
        <p className="page-subtitle mono">{asset.assetId}</p>
      </header>

      <ReadinessSummary asset={asset} />

      <section aria-labelledby="identity-heading" className="detail-section">
        <h2 id="identity-heading" className="section-title">
          Identity
        </h2>
        <dl className="detail-grid">
          <div className="detail-row">
            <dt>Chain</dt>
            <dd className="mono">{asset.chainId}</dd>
          </div>
          <div className="detail-row">
            <dt>Token</dt>
            <dd>
              <AddressLink address={asset.tokenAddress} chainId={asset.chainId} />
              <CopyButton value={asset.tokenAddress} label="token address" />
            </dd>
          </div>
          <div className="detail-row">
            <dt>Current wrapper</dt>
            <dd>
              {asset.wrapperAddress === null ? (
                <StatusBadge tone="unknown" label="NOT DECLARED" />
              ) : (
                <>
                  <AddressLink address={asset.wrapperAddress} chainId={asset.chainId} />
                  <CopyButton value={asset.wrapperAddress} label="wrapper address" />
                  {asset.wrapperIsCurrent === false && (
                    <StatusBadge tone="blocked" label="SUPERSEDED" />
                  )}
                  {asset.wrapperIsCurrent === null && (
                    <StatusBadge tone="unknown" label="VERSION UNKNOWN" />
                  )}
                </>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="multiplier-heading" className="detail-section">
        <h2 id="multiplier-heading" className="section-title">
          Multiplier epoch
        </h2>
        <dl className="detail-grid">
          <div className="detail-row">
            <dt>Current multiplier</dt>
            <dd className="mono">{formatMultiplier(asset.multiplier)}</dd>
          </div>
          <div className="detail-row">
            <dt>Nonce</dt>
            <dd className="mono">{asset.multiplierNonce ?? '—'}</dd>
          </div>
          <div className="detail-row">
            <dt>Next activation</dt>
            <dd className="mono">{asset.scheduledActivation ?? 'none scheduled'}</dd>
          </div>
        </dl>
        <p className="detail-note">
          The nonce is read from chain only. The xStocks API does not publish one, so agreement on
          it cannot be established between sources; it is instead checked directly against the
          caller&rsquo;s operation and re-verified on chain by the adapter.
        </p>
      </section>

      <section aria-labelledby="provenance-heading" className="detail-section">
        <h2 id="provenance-heading" className="section-title">
          Evidence provenance
        </h2>
        <dl className="detail-grid">
          <div className="detail-row">
            <dt>API observation</dt>
            <dd>
              <EvidenceAge
                ageMs={ageOf(asset.apiObservedAt)}
                staleAfterMs={API_STALE_AFTER_MS}
                observedAtIso={asset.apiObservedAt ?? undefined}
              />
            </dd>
          </div>
          <div className="detail-row">
            <dt>Chain observation</dt>
            <dd>
              <EvidenceAge
                ageMs={ageOf(asset.chainObservedAt)}
                staleAfterMs={CHAIN_STALE_AFTER_MS}
                observedAtIso={asset.chainObservedAt ?? undefined}
              />
            </dd>
          </div>
          <div className="detail-row">
            <dt>Observed at block</dt>
            <dd className="mono">
              {asset.chainBlockNumber ?? '—'}
              {asset.chainBlockHash !== null && (
                <>
                  {' · '}
                  <span title={asset.chainBlockHash}>{truncateAddress(asset.chainBlockHash)}</span>
                  <CopyButton value={asset.chainBlockHash} label="block hash" />
                </>
              )}
            </dd>
          </div>
        </dl>
      </section>
    </>
  );
}

/**
 * A plain-language readiness summary, derived deterministically from the evidence shown
 * above. It is a restatement of what the operator can already see, never an inference — and
 * it is explicitly not the authorization decision, which only the API can make.
 */
function ReadinessSummary({ asset }: { asset: Asset }) {
  const blockers: { code: string; explanation: string }[] = [];

  if (asset.canonicality !== 'PASS') {
    blockers.push({
      code: asset.canonicality === 'FAIL' ? 'NON_CANONICAL_TOKEN' : 'NON_CANONICAL_TOKEN',
      explanation: `Canonicality is ${asset.canonicality}. Only a complete PASS permits a protected action.`,
    });
  }
  if (asset.wrapperIsCurrent === false) {
    blockers.push({
      code: 'OUTDATED_WRAPPER',
      explanation: 'This wrapper has been superseded. Only the current wrapper may be used.',
    });
  }
  if (asset.lifecycleState === 'GUARD_WINDOW') {
    blockers.push({
      code: 'ACTIVATION_WINDOW',
      explanation: 'The current time falls inside the guard window around a scheduled activation.',
    });
  }
  if (asset.lifecycleState === 'MISMATCH' || asset.lifecycleState === 'MANUAL_REVIEW') {
    blockers.push({
      code: asset.lifecycleState === 'MISMATCH' ? 'SOURCE_MISMATCH' : 'MANUAL_REVIEW_REQUIRED',
      explanation: 'Sources disagree, or an open incident requires operator review.',
    });
  }
  if (asset.chainObservedAt === null) {
    blockers.push({
      code: 'RPC_UNAVAILABLE',
      explanation: 'No chain observation has been recorded.',
    });
  }
  if (asset.apiObservedAt === null) {
    blockers.push({
      code: 'API_UNAVAILABLE',
      explanation: 'No API observation has been recorded.',
    });
  }

  return (
    <section aria-labelledby="readiness-heading" className="detail-section">
      <h2 id="readiness-heading" className="section-title">
        Integration impact
      </h2>
      {blockers.length === 0 ? (
        <InlineAlert
          tone="info"
          title="No blocking condition is visible in the evidence shown here."
        >
          This is a restatement of the evidence above, not an authorization. Only{' '}
          <code>POST /v1/preflight</code> decides whether a specific operation may proceed, and it
          evaluates freshness and source agreement at the moment of the request.
        </InlineAlert>
      ) : (
        <InlineAlert tone="danger" title="Protected actions on this asset would be refused.">
          <ul className="blocker-list">
            {blockers.map((b) => (
              <li key={b.code}>
                <ReasonCode code={b.code} explanation={b.explanation} /> {b.explanation}
              </li>
            ))}
          </ul>
        </InlineAlert>
      )}
    </section>
  );
}
