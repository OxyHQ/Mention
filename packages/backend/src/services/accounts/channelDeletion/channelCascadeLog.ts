// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * The one name this cascade answers to.
 *
 * Every log line and every error message the channel deletion produces — across
 * the target read, the binding table, the run accounting, the federation
 * broadcasts and the counter repair — carries this prefix, so a single filter
 * follows one run through all of them. Written once, because a second spelling
 * would split a run's evidence in half exactly when somebody is reading it.
 */
export const LOG_PREFIX = '[ChannelDeletion]';
