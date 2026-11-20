import type { HydratedPost } from '@mention/shared-types';

/**
 * A post with the fields every stored post carries, for tests that only care
 * about a few of them. The posts store keeps the canonical shape
 * (`db/feedItem.toFeedItem`), which reads these.
 */
export function canonicalPost(fields: Partial<HydratedPost> & { id: string }): HydratedPost {
  return {
    content: {},
    attachments: {},
    engagement: {},
    viewerState: {},
    metadata: {},
    ...fields,
  } as unknown as HydratedPost;
}
