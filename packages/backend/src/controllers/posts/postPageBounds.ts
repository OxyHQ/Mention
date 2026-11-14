import { config } from '../../config';

/**
 * The page bounds every post LIST endpoint here shares.
 *
 * `getPosts`, the hashtag and topic listings, the saved list and the engagement
 * lists all clamp a client-supplied `limit` the same way
 * through `resolvePageLimit(req.query.limit, POST_PAGE_LIMIT)`,
 * so the two bounds live in one place: raising the ceiling for one list must
 * not silently leave another on the old one.
 */
const DEFAULT_PAGE_SIZE = config.posts.defaultPageSize;
export const MAX_PAGE_SIZE = config.posts.maxPageSize;

/** The `{ fallback, max }` those lists hand `resolvePageLimit`. */
export const POST_PAGE_LIMIT = { fallback: DEFAULT_PAGE_SIZE, max: MAX_PAGE_SIZE };
