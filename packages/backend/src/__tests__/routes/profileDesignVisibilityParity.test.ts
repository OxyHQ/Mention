import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostType, PostVisibility } from '@mention/shared-types';

/**
 * `GET /profile/design/:userId` and `GET /profile/settings/:userId` serve the
 * SAME profile-design DTO (banner, appearance, customization, pinned profile
 * media) — the design route through `extractPublicProfileData`, the settings
 * route through `buildSettingsResponseForViewer`. Only the design route gated it
 * on `privacy.profileVisibility`, so a private profile's design was readable
 * through the settings route by any authenticated account that followed nobody.
 *
 * Both handlers now share ONE rule (`canViewProfileDesign`), and these tests run
 * the REAL handlers, the REAL DTO builders and the REAL gate — only the Oxy
 * follow graph and the (still-Mongo) `UserSettings` document are stubbed — so the
 * two routes are asserted to agree on the same seeded document.
 *
 * The design route also reports the profile's post counters, and those are a
 * REAL grouped query over `posts` now: one pass with three `count(*) filter (…)`
 * aggregates. A stubbed `countDocuments` could not tell that pass from one whose
 * filters select nothing, which is what the counts test below is for.
 */

/** Namespaced: one database serves the whole parallel run and the counts are real. */
const TARGET = 'oxy-profile-design-parity-target';
const VIEWER = 'oxy-profile-design-parity-viewer';

/** viewerId → the ids that viewer follows, as the Oxy graph would report them. */
const followingByViewer = new Map<string, string[]>();

/** The seeded UserSettings document for TARGET, or null when it has none. */
let targetDoc: Record<string, unknown> | null = null;

/** The viewer each route sees; `undefined` models an anonymous design request. */
let currentViewer: string | undefined = VIEWER;

// Only `publicApiUrl` is pinned — the rest of the config is REAL, because
// `connectPostgres` reads `config.postgres.url` from the same object and a
// wholesale replacement leaves it undefined.
vi.mock('../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config')>();
  return {
    ...actual,
    config: { ...actual.config, publicApiUrl: 'https://api.mention.earth' },
  };
});

// One stub stands in for both Oxy seams these routes reach: media URL
// construction (mediaResolver) and the follow graph the visibility gate reads.
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getBaseURL: () => 'https://api.oxy.so',
    getCloudURL: () => 'https://cloud.oxy.so',
    getFileDownloadUrl: (fileId: string, variant?: string) =>
      `https://cloud.oxy.so/${encodeURIComponent(fileId)}${variant ? `?variant=${variant}` : ''}`,
    getUserFollowing: (userId: string) =>
      Promise.resolve({ following: followingByViewer.get(userId) ?? [] }),
  }),
  ensureProfileMediaPublic: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../models/UserSettings', () => ({
  default: {
    findOne: () => ({
      lean: () => {
        const query = {
          exec: () => Promise.resolve(targetDoc),
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(targetDoc).then(resolve),
        };
        return query;
      },
    }),
  },
}));

vi.mock('@oxyhq/core/server', () => ({
  requireOxyAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!currentViewer) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  },
  getRequiredOxyUserId: (req: express.Request & { user?: { id: string } }) => req.user?.id ?? '',
}));

// Imported by the settings router for surfaces this test never exercises.
vi.mock('../../utils/syraPodcast', () => ({ syraClient: {} }));
vi.mock('../../connectors/outboundFederation', () => ({
  federateAsResolvedActor: vi.fn(),
}));
vi.mock('../../models/UserBehavior', () => ({ default: {} }));
vi.mock('../../models/Bookmark', () => ({ default: {} }));
vi.mock('../../models/Like', () => ({ default: {} }));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import profileDesignRoutes from '../../routes/profileDesign';
import profileSettingsRoutes from '../../routes/profileSettings';

const scope = postScope('profile-design-parity');

const app = express();
app.use(express.json());
app.use((req: express.Request & { user?: { id: string }; accessToken?: string }, _res, next) => {
  if (currentViewer) {
    req.user = { id: currentViewer };
    req.accessToken = 'test-token';
  }
  next();
});
app.use('/profile/design', profileDesignRoutes);
app.use('/profile', profileSettingsRoutes);

interface ProfileDesignPayload {
  appearance?: { primaryColor?: string };
  profileHeaderImage?: string;
  profileCustomization?: { coverPhotoEnabled: boolean; minimalistMode: boolean };
  profileMedia?: { type: string };
  postsCount?: number;
  boostsCount?: number;
  repliesCount?: number;
}

async function getDesign(): Promise<ProfileDesignPayload> {
  const res = await request(app).get(`/profile/design/${TARGET}`).expect(200);
  return res.body.data as ProfileDesignPayload;
}

async function getSettings(): Promise<ProfileDesignPayload> {
  const res = await request(app).get(`/profile/settings/${TARGET}`).expect(200);
  return res.body.data as ProfileDesignPayload;
}

/** Every design field a viewer without profile access must not receive. */
function designFields(payload: ProfileDesignPayload) {
  return {
    appearance: payload.appearance,
    profileHeaderImage: payload.profileHeaderImage,
    profileCustomization: payload.profileCustomization,
    profileMedia: payload.profileMedia,
  };
}

function seedTarget(profileVisibility: 'public' | 'private' | 'followers_only') {
  targetDoc = {
    oxyUserId: TARGET,
    appearance: { themeMode: 'dark', primaryColor: '#ff0000' },
    profileHeaderImage: 'private-banner-file',
    profileCustomization: {
      coverPhotoEnabled: true,
      minimalistMode: true,
      profileMedia: {
        type: 'song',
        syraTrackId: 'track-1',
        title: 'A private song',
        artist: 'Someone',
        artworkUrl: 'https://cdn.syra.fm/artwork.jpg',
        previewUrl: 'https://cdn.syra.fm/preview.mp3',
        startSec: 0,
        durationSec: 180,
      },
    },
    privacy: { profileVisibility, showSensitiveContent: true, hiddenWords: ['secret'] },
  };
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  followingByViewer.clear();
  currentViewer = VIEWER;
  targetDoc = null;
});

afterEach(async () => {
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('GET /profile/settings/:userId profile-design visibility', () => {
  it('withholds a private profile\'s design from a stranger', async () => {
    seedTarget('private');
    followingByViewer.set(VIEWER, []);

    const settings = await getSettings();

    expect(settings.profileHeaderImage).toBeUndefined();
    expect(settings.appearance).toBeUndefined();
    expect(settings.profileCustomization).toBeUndefined();
    expect(settings.profileMedia).toBeUndefined();
  });

  it('withholds a followers-only profile\'s design from a non-follower', async () => {
    seedTarget('followers_only');
    followingByViewer.set(VIEWER, ['someone-else']);

    expect(designFields(await getSettings())).toEqual({
      appearance: undefined,
      profileHeaderImage: undefined,
      profileCustomization: undefined,
      profileMedia: undefined,
    });
  });

  // The banner assertions below are about DISCLOSURE, not URL construction: they
  // only require the resolved URL to still address the seeded file. How a bare
  // file id becomes a final URL (and which variant it carries) is owned by
  // `mediaResolver` and covered by `utils/userSettings.test.ts`.
  it('serves the design to a follower of a private profile', async () => {
    seedTarget('private');
    followingByViewer.set(VIEWER, [TARGET]);

    const settings = await getSettings();

    expect(settings.profileHeaderImage).toContain('private-banner-file');
    expect(settings.appearance).toEqual({ primaryColor: '#ff0000' });
    expect(settings.profileCustomization).toEqual({
      coverPhotoEnabled: true,
      minimalistMode: true,
    });
    expect(settings.profileMedia?.type).toBe('song');
  });

  it('serves the design of a public profile to a stranger', async () => {
    seedTarget('public');
    followingByViewer.set(VIEWER, []);

    const settings = await getSettings();

    expect(settings.profileHeaderImage).toContain('private-banner-file');
    expect(settings.appearance).toEqual({ primaryColor: '#ff0000' });
  });

  it('serves the owner their own private profile design', async () => {
    seedTarget('private');
    currentViewer = TARGET;
    followingByViewer.set(TARGET, []);

    const settings = await getSettings();

    expect(settings.profileHeaderImage).toBe('private-banner-file');
    expect(settings.appearance).toEqual({ themeMode: 'dark', primaryColor: '#ff0000' });
  });
});

describe('GET /profile/design/:userId post counters', () => {
  /** A post by TARGET. `overrides` decides which of the three counters it lands in. */
  async function seedTargetPost(overrides: Parameters<typeof seedPost>[1] = {}) {
    return seedPost(scope, {
      oxyUserId: TARGET,
      authorship: [{ oxyUserId: TARGET, role: 'owner', status: 'accepted' }],
      ...overrides,
    });
  }

  it('splits the profile’s public posts into posts / boosts / replies', async () => {
    // `postsCount` counts NON-replies and deliberately includes boosts, matching
    // what the `posts` profile tab actually serves; `repliesCount` is its
    // inverse. Three counters over one pass, so a filter that selects nothing —
    // or everything — is only visible against known rows.
    const root = await seedTargetPost();
    await seedTargetPost({ parentPostId: root.id, threadId: root.id });
    await seedTargetPost({ parentPostId: root.id, threadId: root.id });
    await seedTargetPost({ type: PostType.BOOST, boostOf: root.id });
    // Neither of these is public+published, so neither may be counted.
    await seedTargetPost({ visibility: PostVisibility.PRIVATE });
    await seedTargetPost({ status: 'draft' });
    // Somebody else's post, to prove the pass is scoped to this profile.
    await seedPost(scope, {
      oxyUserId: VIEWER,
      authorship: [{ oxyUserId: VIEWER, role: 'owner', status: 'accepted' }],
    });

    seedTarget('public');
    followingByViewer.set(VIEWER, []);

    const design = await getDesign();

    expect(design.postsCount).toBe(2);
    expect(design.boostsCount).toBe(1);
    expect(design.repliesCount).toBe(2);
  });

  it('reports zero for a profile with no posts at all', async () => {
    seedTarget('public');
    followingByViewer.set(VIEWER, []);

    expect(await getDesign()).toMatchObject({
      postsCount: 0,
      boostsCount: 0,
      repliesCount: 0,
    });
  });
});

describe('profile design and profile settings agree on visibility', () => {
  it.each(['private', 'followers_only', 'public'] as const)(
    'returns the same design fields from both routes for a %s profile',
    async (profileVisibility) => {
      seedTarget(profileVisibility);
      followingByViewer.set(VIEWER, []);

      expect(designFields(await getSettings())).toEqual(designFields(await getDesign()));
    },
  );
});
