/**
 * The coordinates `PUT /posts/:id` accepts, in both directions.
 *
 * `contentLocation` / `postLocation` were tested for `!== undefined` and then
 * written into `double precision` columns guarded by
 * `posts_content_location_range_check` / `posts_location_range_check`. Measured
 * against a real Postgres: `latitude: 'x'` is a driver error, `latitude: 999` is
 * a check violation, `latitude: null` is a pair-check violation — all three a
 * 500 that failed the WHOLE edit, not just the part of it that named a location.
 *
 * `createThread` performs exactly the right check a few hundred lines away, and
 * that asymmetry is the evidence; this path now applies the same one.
 *
 * The post under edit is a REAL ROW and every assertion reads the STORED value
 * back, because "the edit was refused" and "the edit was applied and then read
 * from the request instead of the database" look identical from the response.
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

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { updatePost } from '../../controllers/posts/updatePost';

const scope = serviceScope('update-post-location-validation');
const USER_ID = scope.user('author');

/** The post under edit. Assigned by `seedTarget`, before any request is built. */
let POST_ID = '';

/** Coordinates the seeded post already carries, so a REFUSED edit is visible. */
const SEEDED_LOCATION = { type: 'Point' as const, coordinates: [2.17, 41.38] as [number, number] };

async function seedTarget(): Promise<void> {
  const record = await seedPost(scope, {
    oxyUserId: USER_ID,
    status: 'published',
    // Inside the 30-minute edit window, so nothing here is refused for age.
    createdAt: new Date(),
    content: {
      variants: [{ tag: 'en', source: 'author', text: 'original' }],
      location: SEEDED_LOCATION,
    },
    location: SEEDED_LOCATION,
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

function buildResponse() {
  const captured: { status?: number; body?: { message?: string } } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: { message?: string }) {
      captured.body = body;
      return this;
    },
  };
  return { res, captured };
}

async function edit(body: Record<string, unknown>) {
  const { res, captured } = buildResponse();
  await updatePost(buildRequest(body) as never, res as never);
  return captured;
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

describe('contentLocation — the pair is now tested for BEING a pair', () => {
  it('leaves the stored location alone for an out-of-range latitude, instead of 500ing the edit', async () => {
    const captured = await edit({ contentLocation: { latitude: 999, longitude: 2.1 } });

    // The rest of the edit is what used to be lost with it.
    expect(captured.status).not.toBe(500);
    expect((await readPost(POST_ID))?.content.location).toEqual(SEEDED_LOCATION);
  });

  it('does the same for a non-numeric latitude and for an explicit null', async () => {
    for (const contentLocation of [
      { latitude: 'x', longitude: 2.1 },
      // `null !== undefined`, so this passed the old guard and reached the
      // all-or-nothing pair check as a half-written pair.
      { latitude: null, longitude: 2.1 },
      { latitude: 41.4, longitude: 999 },
    ]) {
      const captured = await edit({ contentLocation });
      expect(captured.status, JSON.stringify(contentLocation)).not.toBe(500);
      expect((await readPost(POST_ID))?.content.location).toEqual(SEEDED_LOCATION);
    }
  });

  it('still writes a valid pair', async () => {
    const captured = await edit({ contentLocation: { latitude: -33.87, longitude: 151.21, address: 'Sydney' } });

    expect(captured.status).toBeUndefined();
    expect((await readPost(POST_ID))?.content.location).toEqual({
      type: 'Point',
      coordinates: [151.21, -33.87],
      address: 'Sydney',
    });
  });

  it('still erases on an explicit null, which is not the same as omitting the field', async () => {
    await edit({ contentLocation: null });

    expect((await readPost(POST_ID))?.content.location).toBeUndefined();
  });

  it('still leaves the location untouched when the edit does not mention it', async () => {
    await edit({ content: { text: 'a body edit' } });

    expect((await readPost(POST_ID))?.content.location).toEqual(SEEDED_LOCATION);
  });
});

describe('postLocation — the same guard on the creation-metadata column', () => {
  it('leaves the stored location alone for a coordinate the CHECK would refuse', async () => {
    for (const postLocation of [
      { latitude: 41.4, longitude: 999 },
      { latitude: 'x', longitude: 2.1 },
      { latitude: null, longitude: 2.1 },
    ]) {
      const captured = await edit({ postLocation });
      expect(captured.status, JSON.stringify(postLocation)).not.toBe(500);
      expect((await readPost(POST_ID))?.location).toEqual(SEEDED_LOCATION);
    }
  });

  it('still writes a valid pair, and still erases on an explicit null', async () => {
    await edit({ postLocation: { latitude: 51.5, longitude: -0.12 } });
    expect((await readPost(POST_ID))?.location).toEqual({ type: 'Point', coordinates: [-0.12, 51.5] });

    await edit({ postLocation: null });
    expect((await readPost(POST_ID))?.location).toBeUndefined();
  });
});
