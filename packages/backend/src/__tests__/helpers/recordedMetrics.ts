import { metrics } from '../../utils/metrics';

/**
 * Every series the registry recorded since its last reset, one line each as
 * `name{label="value",...}`, for privacy assertions of the form "this value
 * never reached a label" and their positive controls.
 */
export function recordedMetricsText(): string {
  return metrics
    .getSeries()
    .map(({ metric, labels }) => {
      const pairs = Object.entries(labels).map(([name, value]) => `${name}="${value}"`);
      return `${metric}{${pairs.join(',')}}`;
    })
    .join('\n');
}
