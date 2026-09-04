import type { ReplayEvent, Timeline } from '@/lib/api';
import { InlineAlert } from './primitives';
import { StatusBadge } from './status';

/**
 * Evidence timeline.
 *
 * The event LIST is the primary representation, not a decorative rail. A visual line is
 * supplementary and carries no information the text does not — an operator on a screen
 * reader, or reading a printed incident report, gets the same content.
 *
 * Raw payloads are behind a disclosure rather than hidden: an auditor needs them, and
 * everyone else needs them out of the way.
 */

export function EvidenceTimeline({ timeline }: { timeline: Timeline }) {
  if (timeline.events.length === 0) {
    return (
      <InlineAlert tone="info" title="No evidence recorded yet.">
        Nothing has been journalled for this asset. That is different from an asset with clean
        evidence — there is simply nothing to replay.
      </InlineAlert>
    );
  }

  return (
    <>
      {!timeline.singleProducerVersion && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <InlineAlert tone="warning" title="This range spans more than one code version.">
            {timeline.policyNote} Producer versions: {timeline.producerVersions.join(', ')}.
          </InlineAlert>
        </div>
      )}

      <ol className="timeline">
        {timeline.events.map((event, index) => (
          <li key={event.eventId} className="timeline__item">
            <div className="timeline__rail" aria-hidden="true">
              <span className="timeline__dot" />
              {index < timeline.events.length - 1 && <span className="timeline__line" />}
            </div>
            <div className="timeline__body">
              <div className="timeline__head">
                <span className="timeline__type">{event.eventType.replace(/_/g, ' ')}</span>
                <StatusBadge
                  tone={event.sourceKind === 'XLAYER_RPC' ? 'chain' : 'verified'}
                  label={event.sourceKind}
                />
                {/* Absolute UTC: an incident report written hours later needs the instant. */}
                <time className="timeline__meta" dateTime={event.observedAt}>
                  {event.observedAt}
                </time>
              </div>

              <div className="timeline__meta">
                {event.sourceLocator}
                {event.blockNumber !== null && ` · block ${event.blockNumber}`}
                {` · correlation ${event.correlationId.slice(0, 8)}`}
                {event.causationId !== null && ` · caused by ${event.causationId.slice(0, 8)}`}
              </div>

              <details className="timeline__disclosure">
                <summary>Raw evidence</summary>
                <pre className="timeline__payload">{JSON.stringify(event.payload, null, 2)}</pre>
              </details>
            </div>
          </li>
        ))}
      </ol>

      <p className="served-at mono">
        {timeline.eventCount} event(s)
        {timeline.cutoffEventId !== undefined &&
          ` · replayed to cutoff ${timeline.cutoffEventId.slice(0, 8)}`}
      </p>
    </>
  );
}

/**
 * Per-field source comparison.
 *
 * Shows both values side by side, so "the sources disagree" becomes "the sources disagree
 * about THIS field, and here is each one's answer".
 */
export function ComparisonMatrix({
  fields,
}: {
  fields: readonly {
    field: string;
    agreement: 'MATCH' | 'MISMATCH' | 'INCOMPLETE';
    apiValue: string | null;
    chainValue: string | null;
    requiredForAgreement: boolean;
  }[];
}) {
  return (
    <table className="comparison-table">
      <caption className="visually-hidden">
        Per-field comparison of the xStocks API and X Layer chain observations.
      </caption>
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">API</th>
          <th scope="col">Chain</th>
          <th scope="col">Agreement</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => (
          <tr key={f.field}>
            <th scope="row">
              {f.field}
              {!f.requiredForAgreement && (
                <div className="cell-detail">
                  {/* ADR 0004, said in the UI rather than only in a document. */}
                  chain-authoritative — not scored
                </div>
              )}
            </th>
            <td className="mono">
              {f.apiValue ?? <span className="cell-detail">not supplied</span>}
            </td>
            <td className="mono">
              {f.chainValue ?? <span className="cell-detail">not supplied</span>}
            </td>
            <td>
              <StatusBadge
                tone={
                  f.agreement === 'MATCH'
                    ? 'verified'
                    : f.agreement === 'MISMATCH'
                      ? 'blocked'
                      : 'unknown'
                }
                label={f.agreement}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export type { ReplayEvent };
