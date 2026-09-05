import type { SourceHealth } from '@/components/app-shell';
import type { ApiResult, SourceHealthResponse } from './api';

/** Preserve unknown as unknown; never manufacture a healthy shell from a failed read. */
export function shellSources(
  health: ApiResult<SourceHealthResponse>,
): readonly SourceHealth[] | undefined {
  return health.ok
    ? health.data.sources.map((source) => ({
        name: source.sourceKind,
        healthy: source.healthy,
        detail: source.detail,
      }))
    : undefined;
}
