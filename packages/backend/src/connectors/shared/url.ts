// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Generic, protocol-agnostic URL predicates shared across network connectors.
 *
 * These were previously private members of the monolithic federation helpers.
 * They are extracted here — rather than left in the ActivityPub-specific
 * `activitypub/helpers.ts` — so the protocol-agnostic `shared/federatedMedia.ts`
 * can use them WITHOUT depending on any ActivityPub runtime module (the whole
 * point of the shared layer: a future atproto connector reuses it too).
 */

/** True when `value` is an absolute `http(s)` URL. */
export function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Lowercased host of a remote URL, or `undefined` when the URL is malformed. */
export function getRemoteHost(remoteUrl: string): string | undefined {
  try {
    return new URL(remoteUrl).host.toLowerCase();
  } catch {
    return undefined;
  }
}
