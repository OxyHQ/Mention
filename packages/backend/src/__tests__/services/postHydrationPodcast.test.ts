import { describe, it, expect, vi } from 'vitest';
import type { PostAttachmentBundle, PostContent } from '@mention/shared-types';
import { resolveVariant } from '../../services/posts/postVariants';

/**
 * Unit test for the podcast branch of {@link buildAttachments}:
 * old post/cache objects can carry provider snapshots, but hydration must expose
 * only the opaque reference. A post without a reference omits the attachment.
 *
 * `buildAttachments` is called directly. It performs no DB / network I/O for the podcast
 * branch, so the client imports are stubbed only so the service module
 * imports cleanly (mirrors the mention-hydration test harness).
 *
 * It takes the reader's RESOLVED language rendition (media + article), because the
 * attachment bundle must render the same rendition as `content` — hydration
 * resolves it once per post and threads it into both.
 */

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ getUserById: vi.fn() }),
}));

// The bulk service-token client used elsewhere in the service.
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getUsersByIds: vi.fn() }),
}));

// Legacy-store models are not touched on the buildAttachments path; stub to empty objects.
vi.mock('../../services/accounts/userSummaryCache', () => ({
  mget: vi.fn(async () => new Map()),
  mset: vi.fn(async () => undefined),
}));

import { buildAttachments } from '../../services/posts/postHydration/dto';

/** Build the bundle the way hydration does: on the reader's resolved rendition. */
function buildBundle(content: PostContent): PostAttachmentBundle {
  return buildAttachments({ content }, new Map(), resolveVariant(content));
}

describe('buildAttachments — podcast', () => {
  it('projects legacy metadata to a reference on the attachment bundle', () => {
    const podcast = {
      syraPodcastId: 'show-123',
      title: 'The Syra Show',
      author: 'Jane Doe',
      artworkUrl: 'https://api.syra.fm/api/images/art-1',
      showUrl: 'https://syra.fm/podcasts/show-123',
    };

    const attachments = buildBundle({ podcast });

    expect(attachments.podcast).toEqual({ syraPodcastId: 'show-123' });
  });

  it('omits podcast from the bundle when the post has no podcast', () => {
    const attachments = buildBundle({ text: 'hello' });

    expect(attachments.podcast).toBeUndefined();
  });
});
