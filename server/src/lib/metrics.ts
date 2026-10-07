/**
 * Minimal Prometheus counters (no dependency). Scrape GET /metrics with
 * `Authorization: Bearer <OPS_API_KEY>`. Values are per instance; sum in Grafana.
 */
const counters = new Map<string, number>();
export const metrics = {
  inc(name: string, by = 1) { counters.set(name, (counters.get(name) ?? 0) + by); },
  render(gauges: Record<string, number>) {
    const lines: string[] = [];
    for (const [k, v] of counters) lines.push(`# TYPE journeychat_${k} counter`, `journeychat_${k} ${v}`);
    for (const [k, v] of Object.entries(gauges)) lines.push(`# TYPE journeychat_${k} gauge`, `journeychat_${k} ${v}`);
    return lines.join('\n') + '\n';
  },
};
