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
