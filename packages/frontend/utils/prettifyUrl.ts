// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Strips the scheme (`http(s)://`), a leading `www.`, and a trailing slash from
 * a URL for compact display. Extracted from the inline regex previously used in
 * `ProfileMeta` so the profile link summary row and sheet share one source.
 */
export const prettifyUrl = (url: string): string =>
  url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
