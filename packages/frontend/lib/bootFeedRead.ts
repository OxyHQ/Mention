// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Native starts no boot read: its unscoped feeds are served from SQLite, which
 * already paints the last session's rows on a cold start. See
 * `bootFeedRead.web.ts`.
 */
export function startHomeFeedBootRead(): void {}
