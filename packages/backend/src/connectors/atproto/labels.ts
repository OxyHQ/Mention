// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/** One atproto label as a hydrated view carries it (`com.atproto.label.defs#label`). */
export interface AtprotoLabel {
  /** The DID that applied the label: the author (a self-label) or a labeler. */
  src?: string;
  val?: string;
  /** A negation retracts an earlier label of the same value. */
  neg?: boolean;
}

/**
 * The label values on a view that `trustedSources` applied and did not retract.
 * A label from any other labeler is ignored: the label set is only as good as
 * the service that wrote it. Pure.
 */
export function atprotoLabelValues(
  labels: unknown,
  trustedSources: readonly string[],
): Set<string> {
  const values = new Set<string>();
  if (!Array.isArray(labels)) return values;
  for (const label of labels as AtprotoLabel[]) {
    if (
      typeof label?.val === 'string' &&
      typeof label.src === 'string' &&
      trustedSources.includes(label.src) &&
      label.neg !== true
    ) {
      values.add(label.val);
    }
  }
  return values;
}
