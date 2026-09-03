/**
 * Prometheus-compatible metrics, without a vendor dependency.
 *
 * Label values are constrained deliberately: an unbounded label — a request ID, an
 * address, an asset id — turns one metric into millions of time series and takes down the
 * metrics backend rather than the service. `assertBoundedLabel` is the guard.
 */

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricDefinition {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  readonly labelNames: readonly string[];
  /** Histogram bucket upper bounds in the metric's own unit. */
  readonly buckets?: readonly number[];
}

const MAX_LABEL_VALUES_PER_METRIC = 200;

export class MetricsRegistry {
  private readonly definitions = new Map<string, MetricDefinition>();
  private readonly values = new Map<string, number>();
  private readonly histogramCounts = new Map<string, number[]>();
  private readonly histogramSums = new Map<string, number>();
  private readonly seenLabelSets = new Map<string, Set<string>>();

  register(definition: MetricDefinition): void {
    this.definitions.set(definition.name, definition);
    this.seenLabelSets.set(definition.name, new Set());
  }

  private key(name: string, labels: Readonly<Record<string, string>>): string {
    const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1));
    return `${name}{${entries.map(([k, v]) => `${k}="${v}"`).join(',')}}`;
  }

  /**
   * Refuse an unbounded label set.
   *
   * A metric that accepts a request ID as a label will produce one time series per request.
   * Failing loudly here is far better than discovering it when the metrics store falls over.
   */
  private assertBounded(name: string, key: string): void {
    const seen = this.seenLabelSets.get(name);
    if (seen === undefined) return;
    if (seen.has(key)) return;
    if (seen.size >= MAX_LABEL_VALUES_PER_METRIC) {
      throw new Error(
        `metric "${name}" exceeded ${MAX_LABEL_VALUES_PER_METRIC} distinct label sets. ` +
          'A label is unbounded — most likely an id, address, or path was used as a label value.',
      );
    }
    seen.add(key);
  }

  increment(name: string, labels: Readonly<Record<string, string>> = {}, by = 1): void {
    const key = this.key(name, labels);
    this.assertBounded(name, key);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  set(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    const key = this.key(name, labels);
    this.assertBounded(name, key);
    this.values.set(key, value);
  }

  observe(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    const definition = this.definitions.get(name);
    if (definition?.buckets === undefined) throw new Error(`${name} is not a histogram`);
    const key = this.key(name, labels);
    this.assertBounded(name, key);

    const counts =
      this.histogramCounts.get(key) ?? new Array<number>(definition.buckets.length + 1).fill(0);
    for (let i = 0; i < definition.buckets.length; i++) {
      if (value <= definition.buckets[i]!) counts[i] = (counts[i] ?? 0) + 1;
    }
    counts[definition.buckets.length] = (counts[definition.buckets.length] ?? 0) + 1;
    this.histogramCounts.set(key, counts);
    this.histogramSums.set(key, (this.histogramSums.get(key) ?? 0) + value);
  }

  /** Render in Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];
    for (const definition of this.definitions.values()) {
      lines.push(`# HELP ${definition.name} ${definition.help}`);
      lines.push(`# TYPE ${definition.name} ${definition.type}`);

      if (definition.type === 'histogram' && definition.buckets !== undefined) {
        for (const [key, counts] of this.histogramCounts) {
          if (!key.startsWith(`${definition.name}{`)) continue;
          const labelPart = key.slice(definition.name.length + 1, -1);
          const prefix = labelPart === '' ? '' : `${labelPart},`;
          definition.buckets.forEach((bound, i) => {
            lines.push(`${definition.name}_bucket{${prefix}le="${bound}"} ${counts[i] ?? 0}`);
          });
          lines.push(
            `${definition.name}_bucket{${prefix}le="+Inf"} ${counts[definition.buckets.length] ?? 0}`,
          );
          lines.push(`${definition.name}_sum{${labelPart}} ${this.histogramSums.get(key) ?? 0}`);
          lines.push(
            `${definition.name}_count{${labelPart}} ${counts[definition.buckets.length] ?? 0}`,
          );
        }
        continue;
      }

      for (const [key, value] of this.values) {
        if (key.startsWith(`${definition.name}{`)) lines.push(`${key} ${value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  /** Distinct label-set count, for the cardinality test. */
  cardinality(name: string): number {
    return this.seenLabelSets.get(name)?.size ?? 0;
  }
}
