/**
 * CloudWatch Embedded Metric Format (EMF) for per-request metrics.
 *
 * Turns the same fields `requestObservability.ts` already computes
 * (`durationMs`, `queryCount`, `oxyCallCount`) into real CloudWatch custom
 * metrics — p50/p95/p99, dashboards, alarms — at zero extra infrastructure
 * cost: EMF is a plain JSON line on stdout, and Mention's ECS task already
 * ships stdout to CloudWatch Logs via the `awslogs` driver. No OTel SDK, no
 * sidecar, no new IAM.
 *
 * Written directly to stdout rather than through `logger.info`, on purpose:
 * `utils/logger.ts`'s sanitizer caps nesting at `MAX_LOG_DEPTH` and replaces
 * anything past it with `"[Truncated]"` — which lands exactly on an EMF
 * block's `Dimensions`/`Metrics` arrays, corrupting the one part CloudWatch
 * actually parses. EMF's own spec assumes a bare, direct write; this keeps
 * that contract rather than routing it through machinery built for something
 * else.
 */

import { config } from '../config';

const NAMESPACE = 'Mention/Backend';

export interface RequestMetricFields {
  route: string;
  method: string;
  durationMs: number;
  queryCount?: number;
  oxyCallCount?: number;
}

/**
 * Emit one EMF line for a completed request. A no-op when
 * `config.cloudwatch.emfEnabled` is off (default off in tests — see
 * `CLOUDWATCH_EMF_ENABLED`'s config doc).
 */
export function emitRequestMetrics(fields: RequestMetricFields): void {
  if (!config.cloudwatch.emfEnabled) return;

  const metricDefinitions: Array<{ Name: string; Unit: string }> = [
    { Name: 'HttpRequestDurationMs', Unit: 'Milliseconds' },
  ];
  const metricValues: Record<string, number> = { HttpRequestDurationMs: fields.durationMs };

  if (fields.queryCount !== undefined) {
    metricDefinitions.push({ Name: 'QueryCount', Unit: 'Count' });
    metricValues.QueryCount = fields.queryCount;
  }
  if (fields.oxyCallCount !== undefined) {
    metricDefinitions.push({ Name: 'OxyCallCount', Unit: 'Count' });
    metricValues.OxyCallCount = fields.oxyCallCount;
  }

  const line = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: NAMESPACE,
        // By METHOD only. Every distinct dimension set is a billed custom
        // metric (0.30 $/month each): `route` × `method` measured 135
        // combinations × 3 metrics = 405 metrics, ~80 % of the account's
        // CloudWatch bill on 2026-10-10. The route stays a property of this
        // line, so a per-route breakdown is a Logs Insights query
        // (`stats pct(HttpRequestDurationMs, 95) by route`) at no metric cost.
        Dimensions: [['method']],
        Metrics: metricDefinitions,
      }],
    },
    route: fields.route,
    method: fields.method,
    ...metricValues,
  };

  process.stdout.write(`${JSON.stringify(line)}\n`);
}
