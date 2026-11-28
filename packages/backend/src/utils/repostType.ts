// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * The query-side half of {@link REPOST_TYPE_VALUES}: a `type` column that holds a repost
 * under either of its names while `'boost'` is renamed to `'repost'` (docs/repost-rename.md).
 */
import { REPOST_TYPE_VALUES } from '@mention/shared-types';
import { inArray, notInArray, type AnyColumn } from 'drizzle-orm';

/** `type` is a repost, under either name. */
export const typeIsRepost = (column: AnyColumn) => inArray(column, [...REPOST_TYPE_VALUES]);

/** `type` is not a repost, under either name. */
export const typeIsNotRepost = (column: AnyColumn) => notInArray(column, [...REPOST_TYPE_VALUES]);
