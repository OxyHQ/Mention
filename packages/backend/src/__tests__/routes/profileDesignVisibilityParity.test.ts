import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `GET /profile/design/:userId` and `GET /profile/settings/:userId` serve the
 * SAME profile-design DTO (banner, appearance, customization, pinned profile
 * media) — the design route through `extractPublicProfileData`, the settings
 * route through `buildSettingsResponseForViewer`. Only the design route gated it
 * on `privacy.profileVisibility`, so a private profile's design was readable
 * through the settings route by any authenticated account that followed nobody.
 *
 * Both handlers now share ONE rule (`canViewProfileDesign`), and these tests run
 * the REAL handlers, the REAL DTO builders and the REAL gate — only the Mongo
 * document and the Oxy follow graph are stubbed — so the two routes are asserted
 * to agree on the same seeded document.
 */

const TARGET = 'target-user';
const VIEWER = 'viewer-user';

/** viewerId → the ids that viewer follows, as the Oxy graph would report them. */
const followingByViewer = new Map<string, string[]>();

/** The seeded UserSettings document for TARGET, or null when it has none. */
let targetDoc: Record<string, unknown> | null = null;

/** The viewer each route sees; `undefined` models an anonymous design request. */
let currentViewer: string | undefined = VIEWER;

vi.mock('../../config', () => ({
  config: { publicApiUrl: 'https://api.mention.earth' },
}));

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
  createUserScopedOxyServices: vi.fn(() => undefined),
}));

// `profileSettings` reaches this through `PUT /settings/:userId`, whose gate
// resolves an account's kind via `PostHydrationService` — which imports the
// ActivityPub connector and reads `config.federation` at module scope. This suite
// stubs `../../config` down to what IT needs, so the real module would throw on
// import. Nothing here exercises the gate; it is stubbed so the parity assertions
// below stay about profile-design visibility.
vi.mock('../../services/publishAsAccount', () => ({
  PublishAsAccessError: class extends Error {
    readonly status = 403;
  },
  assertCanPublishAsAccount: vi.fn(async () => null),
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

// Post counts are unrelated to visibility; the design route only needs them to
// resolve so the handler reaches its response.
vi.mock('../../models/Post', () => ({
  default: { countDocuments: vi.fn().mockResolvedValue(0) },
  Post: { countDocuments: vi.fn().mockResolvedValue(0) },
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

import profileDesignRoutes from '../../routes/profileDesign';
import profileSettingsRoutes from '../../routes/profileSettings';

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
  profileMedia?: { type: string };
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
    profileMedia: payload.profileMedia,
  };
}

function seedTarget(profileVisibility: 'public' | 'private' | 'followers_only') {
  targetDoc = {
    oxyUserId: TARGET,
    appearance: { themeMode: 'dark', primaryColor: '#ff0000' },
    profileHeaderImage: 'private-banner-file',
    profileCustomization: {
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

beforeEach(() => {
  vi.clearAllMocks();
  followingByViewer.clear();
  currentViewer = VIEWER;
  targetDoc = null;
});

describe('GET /profile/settings/:userId profile-design visibility', () => {
  it('withholds a private profile\'s design from a stranger', async () => {
    seedTarget('private');
    followingByViewer.set(VIEWER, []);

    const settings = await getSettings();

    expect(settings.profileHeaderImage).toBeUndefined();
    expect(settings.appearance).toBeUndefined();
    expect(settings.profileMedia).toBeUndefined();
  });

  it('withholds a followers-only profile\'s design from a non-follower', async () => {
    seedTarget('followers_only');
    followingByViewer.set(VIEWER, ['someone-else']);

    expect(designFields(await getSettings())).toEqual({
      appearance: undefined,
      profileHeaderImage: undefined,
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
