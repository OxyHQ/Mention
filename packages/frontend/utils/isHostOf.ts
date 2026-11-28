// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Whether `host` is `domain` itself or one of its subdomains.
 *
 * A bare `host.endsWith(domain)` also accepts lookalikes — `notspotify.com` ends
 * with `spotify.com` — so the suffix has to start at a label boundary.
 * Both arguments are hostnames (no scheme, port or path), compared as given.
 */
export function isHostOf(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}
