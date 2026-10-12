/**
 * An edit keeps the derived metadata of the media the post keeps.
 *
 * The post under edit is a REAL ROW, and the assertions read its stored media
 * back.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

const hoisted = vi.hoisted(() => ({
  enrichIngestedPosts: vi.fn(),
  hydratePosts: vi.fn(),
  createScopedOxyClient: vi.fn(),
  resolveCollaboratorRefs: vi.fn(),
  emitPostCreated: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: hoisted.createScopedOxyClient,
  createUserScopedOxyServices: vi.fn(() => undefined),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: hoisted.hydratePosts },
  resolveUserSummaries: vi.fn(async () => new Map()),
  degradedActorSummary: (id: string) => ({
    id,
    username: '',
    name: { displayName: 'Unknown user' },
  }),
}));

vi.mock('../../services/PostCollaborationService', () => ({
  postCollaborationService: {
    resolveCollaboratorRefs: hoisted.resolveCollaboratorRefs,
    attachCollaborators: vi.fn(),
    autoAcceptInvites: vi.fn(),
    notifyPendingInvites: vi.fn(),
  },
  CollabValidationError: class extends Error {},
  CollabStateError: class extends Error {},
}));

vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: hoisted.emitPostCreated,
  emitTombstone: vi.fn(),
  postRecordUri: () => 'at://test',
}));

vi.mock('../../services/postEnrichment', () => ({
  enrichIngestedPosts: hoisted.enrichIngestedPosts,
}));

import type { MediaItem } from '@mention/shared-types';
import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { updatePost } from '../../controllers/posts/updatePost';

const scope = serviceScope('update-post-keeps-media-metadata');
const USER_ID = scope.user('author');

/** What Oxy derived about the file: dimensions, duration and the finished H.264 ladder. */
const PROBED_VIDEO: MediaItem = {
  id: 'keep-meta-video-1',
  type: 'video',
  alt: 'A reel',
  width: 1916,
  height: 1078,
  durationSec: 30,
  orientation: 'landscape',
  aspectRatio: 1916 / 1078,
  sizeBytes: 29957083,
  hlsReadyAt: '2026-10-10T18:00:00.000Z',
};

let POST_ID = '';

async function edit(body: Record<string, unknown>): Promise<number | undefined> {
  let status: number | undefined;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
  };
  await updatePost(
    {
      params: { id: POST_ID },
      query: {},
      headers: {},
      acceptsLanguages: () => [] as string[],
      body,
      user: { id: USER_ID },
    } as never,
    res as never,
  );
  return status;
}

async function storedMedia(): Promise<MediaItem[]> {
  return (await readPost(POST_ID))?.content.media ?? [];
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.createScopedOxyClient.mockReturnValue(undefined);
  hoisted.hydratePosts.mockImplementation(async () => [{ id: POST_ID }]);
  hoisted.resolveCollaboratorRefs.mockResolvedValue(undefined);
  const record = await seedPost(scope, {
    oxyUserId: USER_ID,
    status: 'published',
    createdAt: new Date(),
    content: {
      media: [PROBED_VIDEO],
      variants: [{ tag: 'en', source: 'author', text: 'my reel' }],
    },
  });
  POST_ID = record.id;
});

afterEach(async () => {
  await clearServiceScope(scope);
});

/**
 * An edit sends each file's id, type and ALT — not what Oxy derived about it.
 * Writing the sent items as they came wiped the derived fields of every file the
 * post kept; losing the HLS stamp sent every player back to the uploaded
 * original, which an iPhone cannot decode when it is VP9.
 */
describe('an edit keeps what Oxy derived about the media the post keeps', () => {
  it('keeps the dimensions, duration and ladder stamp of a kept file, and takes the new ALT', async () => {
    expect(
      await edit({ content: { media: [{ id: PROBED_VIDEO.id, type: 'video', alt: 'My reel' }] } }),
    ).toBeUndefined();

    expect(await storedMedia()).toEqual([{ ...PROBED_VIDEO, alt: 'My reel' }]);
  });

  it('lets the author clear the ALT of a kept file', async () => {
    await edit({ content: { media: [{ id: PROBED_VIDEO.id, type: 'video' }] } });

    const { alt: _alt, ...withoutAlt } = PROBED_VIDEO;
    expect(await storedMedia()).toEqual([withoutAlt]);
  });

  it('stores a new file as sent and hands the post to the post-ingest enrichment', async () => {
    await edit({
      content: {
        media: [
          { id: PROBED_VIDEO.id, type: 'video' },
          { id: 'keep-meta-video-2', type: 'video' },
        ],
      },
    });

    const media = await storedMedia();
    expect(media[1]).toEqual({ id: 'keep-meta-video-2', type: 'video' });
    expect(hoisted.enrichIngestedPosts).toHaveBeenCalledWith([
      expect.objectContaining({ id: POST_ID, content: expect.objectContaining({ media }) }),
    ]);
  });
});
