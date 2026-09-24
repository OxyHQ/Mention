/**
 * An edit drops the post's machine translations whenever it changes what they
 * were translated FROM — the primary body, the ALT text of the media the primary
 * shows, or the article — and keeps them when it changes nothing of the kind.
 *
 * A translation that outlives its source is served to every reader of that
 * locale as if it described the post (#1103). The body case was already handled;
 * ALT-only and article-only edits were not.
 *
 * The post under edit is a REAL ROW, and the assertions read the stored variants
 * and `post_variant_alt_texts` rows back.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

const hoisted = vi.hoisted(() => ({
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
  degradedActorSummary: (id: string) => ({ id, username: '', name: { displayName: 'Unknown user' } }),
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

import { inArray } from 'drizzle-orm';
import type { MediaItem } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { postContentVariants, postVariantAltTexts } from '../../db/schema/postContent';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { updatePost } from '../../controllers/posts/updatePost';

const scope = serviceScope('update-post-drops-machine-variants');
const USER_ID = scope.user('author');
const MEDIA: MediaItem[] = [{ id: 'drop-machine-img-1', type: 'image', alt: 'A red car' }];

let POST_ID = '';

async function seedTarget(): Promise<void> {
  const record = await seedPost(scope, {
    oxyUserId: USER_ID,
    status: 'published',
    createdAt: new Date(),
    content: {
      media: MEDIA,
      article: { title: 'Car diary', excerpt: 'Day one' },
      variants: [
        { tag: 'en-US', source: 'author', text: 'I bought a car' },
        {
          tag: 'es-MX',
          source: 'machine',
          text: 'Me compré un carro',
          alt: { 'drop-machine-img-1': 'Un carro rojo' },
          article: { title: 'Diario del carro', excerpt: 'Día uno' },
        },
      ],
    },
  });
  POST_ID = record.id;
}

function buildRequest(body: Record<string, unknown>) {
  return {
    params: { id: POST_ID },
    query: {},
    headers: {},
    acceptsLanguages: () => [] as string[],
    body,
    user: { id: USER_ID },
  };
}

/** Run the edit; resolves to the error status it answered with, if any. */
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
  await updatePost(buildRequest(body) as never, res as never);
  return status;
}

async function storedRenditions(): Promise<Array<[string | undefined, string]>> {
  const post = await readPost(POST_ID);
  return (post?.content.variants ?? []).map((variant) => [variant.tag, variant.source]);
}

/** Every localized ALT row still stored against this post's renditions. */
async function altRowCount(): Promise<number> {
  const variants = await getDb()
    .select({ id: postContentVariants.id })
    .from(postContentVariants)
    .where(inArray(postContentVariants.postId, [POST_ID]));
  if (variants.length === 0) return 0;
  const rows = await getDb()
    .select({ id: postVariantAltTexts.id })
    .from(postVariantAltTexts)
    .where(inArray(postVariantAltTexts.variantId, variants.map((row) => row.id)));
  return rows.length;
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
  await seedTarget();
});

afterEach(async () => {
  await clearServiceScope(scope);
});

describe('machine translations do not survive a change to their source', () => {
  it('starts from a stored machine variant with localized ALT', async () => {
    expect(await storedRenditions()).toEqual([['en-US', 'author'], ['es-MX', 'machine']]);
    expect(await altRowCount()).toBe(1);
  });

  it('drops them, with their ALT rows, when only the media ALT text changes', async () => {
    expect(await edit({ media: [{ ...MEDIA[0], alt: 'A blue car' }] })).toBeUndefined();

    expect(await storedRenditions()).toEqual([['en-US', 'author']]);
    expect(await altRowCount()).toBe(0);
    expect((await readPost(POST_ID))?.content.media?.[0]?.alt).toBe('A blue car');
  });

  it('drops them when only the article changes', async () => {
    expect(await edit({ article: { title: 'Bike diary', body: 'Day one' } })).toBeUndefined();

    expect(await storedRenditions()).toEqual([['en-US', 'author']]);
    expect(await altRowCount()).toBe(0);
  });

  it('drops them when the body changes (the case that was already handled)', async () => {
    expect(await edit({ text: 'I sold my car' })).toBeUndefined();

    // The primary is re-tagged by detection on a body edit, so only the sources
    // are asserted here.
    expect((await storedRenditions()).map(([, source]) => source)).toEqual(['author']);
  });

  it('keeps them when the edit changes nothing they were translated from', async () => {
    expect(await edit({ hashtags: ['cars'] })).toBeUndefined();
    expect(await edit({ media: MEDIA })).toBeUndefined();

    expect(await storedRenditions()).toEqual([['en-US', 'author'], ['es-MX', 'machine']]);
    expect(await altRowCount()).toBe(1);
  });
});
