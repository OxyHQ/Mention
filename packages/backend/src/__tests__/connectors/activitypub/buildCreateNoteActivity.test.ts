import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `buildCreateNoteActivity` is the SINGLE Note builder shared by push delivery,
 * the outbox page, and the per-post dereference route. These tests pin the
 * full-fidelity Note it emits — canonical `url`, hashtag `tag`s, and media
 * `attachment`s built through the canonical media chokepoint — and its fail-soft
 * behavior (a bad media item never breaks the Note).
 *
 * The builder's transitive deps (actor/crypto/queue/models) are stubbed so it
 * imports in isolation; only `resolveMediaRef` (the media chokepoint) is given
 * controllable output for attachment-URL assertions.
 */

vi.mock('../../../connectors/activitypub/actor.service', () => ({ actorService: {} }));
vi.mock('../../../connectors/activitypub/crypto', () => ({ getPublicKey: vi.fn(), signRequest: vi.fn() }));
vi.mock('../../../queue/producers', () => ({ enqueueDelivery: vi.fn(), enqueueInboxActivity: vi.fn() }));
vi.mock('../../../models/FederatedActor', () => ({ default: {} }));
vi.mock('../../../models/FederatedFollow', () => ({ default: {} }));
vi.mock('../../../models/FederationDeliveryQueue', () => ({ default: {} }));
vi.mock('../../../utils/safeUpstreamFetch', () => ({ fetchUpstreamSingleHop: vi.fn() }));
vi.mock('../../../utils/ssrfGuard', () => ({ assertSafePublicUrl: vi.fn() }));

// Native Oxy file id → absolute CDN URL, mirroring the real chokepoint. The
// builder only calls this for NON-absolute refs (file ids); absolute federated
// URLs bypass it and stay raw.
vi.mock('../../../utils/mediaResolver', () => ({
  resolveMediaRef: (ref: string) => ({ url: `https://cloud.oxy.so/${ref}` }),
}));

import { followService } from '../../../connectors/activitypub/follow.service';

const ISO = '2024-01-02T03:04:05.000Z';

function noteFor(post: Parameters<typeof followService.buildCreateNoteActivity>[0]) {
  const activity = followService.buildCreateNoteActivity(post, 'alice');
  return { activity, note: activity.object as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildCreateNoteActivity — canonical url + hashtag tags', () => {
  it('emits the on-site post url and a Hashtag tag per hashtag', () => {
    const { activity, note } = noteFor({
      _id: 'post123',
      content: { text: 'hello world' },
      hashtags: ['news', 'tech'],
      createdAt: ISO,
    });

    expect(activity.type).toBe('Create');
    expect(activity.id).toBe('https://mention.earth/ap/users/alice/posts/post123/activity');
    expect(note.id).toBe('https://mention.earth/ap/users/alice/posts/post123');
    expect(note.url).toBe('https://mention.earth/@alice/posts/post123');
    expect(note.content).toBe('hello world');

    expect(note.tag).toEqual([
      { type: 'Hashtag', href: 'https://mention.earth/hashtag/news', name: '#news' },
      { type: 'Hashtag', href: 'https://mention.earth/hashtag/tech', name: '#tech' },
    ]);
  });

  it('normalizes a Mongoose Date createdAt to a canonical ISO 8601 published', () => {
    const { activity, note } = noteFor({
      _id: 'p1',
      content: { text: 'hi' },
      createdAt: new Date(ISO),
    });

    expect(activity.published).toBe(ISO);
    expect(note.published).toBe(ISO);
  });

  it('omits tag and attachment when the post has neither', () => {
    const { note } = noteFor({ _id: 'p1', content: { text: 'plain' }, createdAt: ISO });
    expect(note.tag).toBeUndefined();
    expect(note.attachment).toBeUndefined();
  });
});

describe('buildCreateNoteActivity — media attachments', () => {
  it('builds Document attachments: native ids via the chokepoint, federated raw urls verbatim', () => {
    const { note } = noteFor({
      _id: 'p1',
      content: {
        text: 'with media',
        media: [
          { id: 'file-abc', type: 'image', alt: 'a cat' },
          { id: 'https://remote.example/pic.png', type: 'image' },
          { id: 'vid-xyz', type: 'video' },
        ],
      },
      createdAt: ISO,
    });

    expect(note.attachment).toEqual([
      // Native file id → resolved CDN url (no extension → category default), alt → name.
      { type: 'Document', mediaType: 'image/jpeg', url: 'https://cloud.oxy.so/file-abc', name: 'a cat' },
      // Federated raw url stays raw; extension .png → precise mediaType; no alt → no name.
      { type: 'Document', mediaType: 'image/png', url: 'https://remote.example/pic.png' },
      // Native video id → category default video/mp4.
      { type: 'Document', mediaType: 'video/mp4', url: 'https://cloud.oxy.so/vid-xyz' },
    ]);
  });

  it('is fail-soft: skips a media item with an empty id but keeps the good ones', () => {
    const { note } = noteFor({
      _id: 'p1',
      content: {
        text: 'partial',
        media: [
          { id: '', type: 'image' },
          { id: 'file-ok', type: 'gif' },
        ],
      },
      createdAt: ISO,
    });

    expect(note.attachment).toEqual([
      { type: 'Document', mediaType: 'image/gif', url: 'https://cloud.oxy.so/file-ok' },
    ]);
  });
});
