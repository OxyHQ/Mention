import { config } from '../../config';

/**
 * The page bounds every post LIST endpoint here shares.
 *
 * `getPosts`, the hashtag and topic listings, the saved list and the engagement
 * lists all clamp a client-supplied `limit` the same way
 * (`Math.min(queryInt(req.query.limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)`),
 * so the two bounds live in one place: raising the ceiling for one list must
 * not silently leave another on the old one.
 */
export const DEFAULT_PAGE_SIZE = config.posts.defaultPageSize;
export const MAX_PAGE_SIZE = config.posts.maxPageSize;
