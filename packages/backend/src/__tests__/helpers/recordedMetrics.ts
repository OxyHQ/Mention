// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
