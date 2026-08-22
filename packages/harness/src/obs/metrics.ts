/**
 * Metrics seam. High-signal, low-cardinality counters/histograms tied to SLOs.
 * Default is no-op; a host wires this to Prometheus/EMF (mlpal-infra has Prometheus).
 * Kept minimal on purpose — a seam, not a framework.
 */
export interface Metrics {
  increment(name: string, value?: number, tags?: Record<string, string>): void;
  histogram(name: string, value: number, tags?: Record<string, string>): void;
}

export const noopMetrics: Metrics = {
  increment() {},
  histogram() {},
};

/** In-memory metrics for tests / local inspection. */
export class MemoryMetrics implements Metrics {
  readonly counters = new Map<string, number>();
  readonly observations = new Map<string, number[]>();

  private key(name: string, tags?: Record<string, string>): string {
    if (!tags || Object.keys(tags).length === 0) return name;
    const t = Object.entries(tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return `${name}{${t}}`;
  }

  increment(name: string, value = 1, tags?: Record<string, string>): void {
    const k = this.key(name, tags);
    this.counters.set(k, (this.counters.get(k) ?? 0) + value);
  }

  histogram(name: string, value: number, tags?: Record<string, string>): void {
    const k = this.key(name, tags);
    const arr = this.observations.get(k) ?? [];
    arr.push(value);
    this.observations.set(k, arr);
  }
}
