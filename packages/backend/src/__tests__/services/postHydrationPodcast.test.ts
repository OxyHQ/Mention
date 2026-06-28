import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PostAttachmentBundle, PostContent, PostPodcastContent } from '@mention/shared-types';

/**
 * Unit test for the podcast branch of {@link PostHydrationService.buildAttachments}:
 * a post whose `content.podcast` carries a server-denormalized Syra show must
 * surface that show on the hydrated `attachments.podcast` bundle, and a post
 * without one must leave `attachments.podcast` absent.
 *
 * `buildAttachments` is private, so it is exercised through a precise structural
 * interface (no `as any`). It performs no DB / network I/O for the podcast
 * branch, so the model + client imports are stubbed only so the service module
 * imports cleanly (mirrors the mention-hydration test harness).
 */

// `server.ts` constructs a live OxyServices client at import time; stub it.
vi.mock('../../../server', () => ({
  oxy: { getUserById: vi.fn() },
}));

// The bulk service-token client used elsewhere in the service.
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getUsersByIds: vi.fn() }),
}));

// Mongo models are not touched on the buildAttachments path; stub to empty objects.
vi.mock('../../models/Post', () => ({ Post: {} }));
vi.mock('../../models/Poll', () => ({ default: {} }));
vi.mock('../../models/Like', () => ({ default: {} }));
vi.mock('../../models/Bookmark', () => ({ default: {} }));
vi.mock('../../models/UserSettings', () => ({ UserSettings: {} }));
vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async () => new Map()),
  mset: vi.fn(async () => undefined),
}));

import { PostHydrationService } from '../../services/PostHydrationService';

/** Precise structural view of the private method under test (no `as any`). */
interface AttachmentBuilder {
  buildAttachments(
    post: { content?: Partial<PostContent> },
    pollMap: Map<string, Record<string, unknown>>,
  ): PostAttachmentBundle;
}

function asBuilder(service: PostHydrationService): AttachmentBuilder {
  return service as unknown as AttachmentBuilder;
}

describe('PostHydrationService.buildAttachments — podcast', () => {
  let service: PostHydrationService;

  beforeEach(() => {
    service = new PostHydrationService();
  });

  it('surfaces a denormalized Syra podcast show on the attachment bundle', () => {
    const podcast: PostPodcastContent = {
      syraPodcastId: 'show-123',
      title: 'The Syra Show',
      author: 'Jane Doe',
      artworkUrl: 'https://api.syra.fm/api/images/art-1',
      showUrl: 'https://syra.fm/podcasts/show-123',
    };

    const attachments = asBuilder(service).buildAttachments({ content: { podcast } }, new Map());

    expect(attachments.podcast).toEqual(podcast);
  });

  it('omits podcast from the bundle when the post has no podcast', () => {
    const attachments = asBuilder(service).buildAttachments({ content: { text: 'hello' } }, new Map());

    expect(attachments.podcast).toBeUndefined();
  });
});
