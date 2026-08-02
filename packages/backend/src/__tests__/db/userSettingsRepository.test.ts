/**
 * `user_settings` — read-after-write, against real rows.
 *
 * ## The failure this file exists for is silence
 *
 * `user_settings` was split across two stores: four Mongoose writers, six
 * Postgres readers. Nothing errored. A viewer toggled "show sensitive content"
 * and the gate that enforces it read a table nobody had written, so the
 * preference simply did not take effect — no exception, no log, no failing
 * request. The only check that catches that shape is one that WRITES through
 * the write path and then READS through the reader's own path, so both of those
 * are real here and neither is stubbed.
 *
 * ## The dotted-path map is the part that fails silently one layer down
 *
 * The settings PUT builds a Mongo `$set`/`$unset` map of dotted paths. Handed
 * to drizzle's `set()`, a dot path is an unknown property that drizzle IGNORES
 * — the write does nothing and throws nothing, which is the original bug
 * reintroduced inside its own fix. Hence `updateUserSettings` throws on an
 * unregistered path, and the case that pins it is the most load-bearing in this
 * file.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { userSettings } from '../../db/schema/userProfile';
import {
  UnknownSettingsPathError,
  ensureUserSettings,
  loadUserSettings,
  loadUserSettingsByIds,
  replaceLabelActions,
  updateUserSettings,
} from '../../db/userProfile/userSettingsRepository';
import { loadShowSensitiveContent } from '../../services/safety/viewerSafety';

const created: string[] = [];

function userId(label: string): string {
  const id = `oxy-usersettings-${label}-${randomUUID()}`;
  created.push(id);
  return id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  if (created.length > 0) {
    await getDb().delete(userSettings).where(inArray(userSettings.oxyUserId, created.splice(0)));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('user settings — read after write', () => {
  it('has no row until something creates one', async () => {
    expect(await loadUserSettings(userId('absent'))).toBeNull();
  });

  it('creates a row carrying the SCHEMA defaults', async () => {
    // The defaults live in the schema and nowhere else, so an insert of nothing
    // but the id has to produce the document the Mongoose writer used to. A
    // second copy of them in the repository is what would drift.
    const user = userId('defaults');

    const record = await ensureUserSettings(user);

    expect(record.appearance.themeMode).toBe('system');
    expect(record.privacy.profileVisibility).toBe('public');
    expect(record.privacy.showSensitiveContent).toBe(false);
    expect(record.profileCustomization.coverPhotoEnabled).toBe(true);
    expect(record.notificationPreferences.pushEnabled).toBe(true);
    expect(record.feedSettings.diversity.enabled).toBe(true);
  });

  it('is idempotent — ensuring twice does not reset a stored change', async () => {
    const user = userId('ensure-twice');
    await updateUserSettings(user, { set: { 'privacy.showSensitiveContent': true } });

    const second = await ensureUserSettings(user);

    expect(second.privacy.showSensitiveContent).toBe(true);
  });

  it('UPSERTS — a change made before any row exists still lands', async () => {
    // Every Mongoose writer passed `{ upsert: true }`. A user whose first action
    // is changing a setting must end up with a row rather than a silent no-op.
    const user = userId('upsert');

    const record = await updateUserSettings(user, {
      set: { 'appearance.themeMode': 'dark' },
    });

    expect(record.appearance.themeMode).toBe('dark');
    expect((await loadUserSettings(user))?.appearance.themeMode).toBe('dark');
  });

  it('round-trips every dotted path shape the settings route produces', async () => {
    const user = userId('paths');

    const record = await updateUserSettings(user, {
      set: {
        'appearance.themeMode': 'dark',
        'appearance.primaryColor': '#ff0000',
        'privacy.profileVisibility': 'private',
        'privacy.hiddenWords': ['spoilers'],
        'privacy.showSensitiveContent': true,
        'profileCustomization.minimalistMode': true,
        'interests.tags': ['cycling'],
        'feedSettings.diversity.sameAuthorPenalty': 0.7,
        'feedSettings.recency.halfLifeHours': 12,
        'notificationPreferences.likes': false,
        'externalEmbeds.youtube': 'show',
        fediversePreferredLanguage: 'es-ES',
      },
    });

    expect(record.appearance).toMatchObject({ themeMode: 'dark', primaryColor: '#ff0000' });
    expect(record.privacy).toMatchObject({
      profileVisibility: 'private',
      hiddenWords: ['spoilers'],
      showSensitiveContent: true,
    });
    expect(record.profileCustomization.minimalistMode).toBe(true);
    expect(record.interests?.tags).toEqual(['cycling']);
    expect(record.feedSettings.diversity.sameAuthorPenalty).toBe(0.7);
    expect(record.feedSettings.recency.halfLifeHours).toBe(12);
    expect(record.notificationPreferences.likes).toBe(false);
    expect(record.externalEmbeds?.youtube).toBe('show');
    expect(record.fediversePreferredLanguage).toBe('es-ES');
  });

  it('THROWS on a path no column is registered for', async () => {
    // The most load-bearing case here. Drizzle silently ignores an unknown
    // property, so without this a new setting whose path nobody registered
    // would be accepted, report success, and never be stored — the exact
    // silent-write bug this port exists to end.
    const user = userId('unknown-path');

    await expect(
      updateUserSettings(user, { set: { 'privacy.somethingNobodyRegistered': true } }),
    ).rejects.toThrow(UnknownSettingsPathError);
  });

  it('restores the DEFAULT when a non-nullable path is unset', async () => {
    // `$unset` on a column that cannot express absence has to mean "back to the
    // value a document without the field read as", not `null` and not whatever
    // was there before.
    const user = userId('unset-default');
    await updateUserSettings(user, { set: { 'appearance.themeMode': 'dark' } });

    const record = await updateUserSettings(user, { unset: { 'appearance.themeMode': '' } });

    expect(record.appearance.themeMode).toBe('system');
  });

  it('clears a nullable path to absent when unset', async () => {
    const user = userId('unset-null');
    await updateUserSettings(user, { set: { 'appearance.primaryColor': '#ff0000' } });

    const record = await updateUserSettings(user, { unset: { 'appearance.primaryColor': '' } });

    expect(record.appearance.primaryColor).toBeUndefined();
  });

  it('REPLACES a pinned song with a podcast, leaving no leftovers', async () => {
    // Both variants share one set of columns, so a partial write leaves the
    // previous item's fields on a row that now claims to hold the other kind.
    // The mutual exclusion is the property; `type` is the only discriminator.
    const user = userId('profile-media');
    await updateUserSettings(user, {
      set: {
        'profileCustomization.profileMedia': {
          type: 'song',
          syraTrackId: 'track-1',
          title: 'A song',
          artist: 'Someone',
          previewUrl: 'https://cdn.test/preview.mp3',
          startSec: 0,
        },
      },
    });

    const record = await updateUserSettings(user, {
      set: {
        'profileCustomization.profileMedia': {
          type: 'podcast',
          syraPodcastId: 'show-1',
          title: 'A show',
          showUrl: 'https://syra.test/show-1',
        },
      },
    });

    expect(record.profileCustomization.profileMedia).toEqual({
      type: 'podcast',
      syraPodcastId: 'show-1',
      title: 'A show',
      showUrl: 'https://syra.test/show-1',
    });
    // The song's own columns are gone, not merely unread.
    const [row] = await getDb()
      .select({
        trackId: userSettings.profileMediaSyraTrackId,
        artist: userSettings.profileMediaArtist,
        previewUrl: userSettings.profileMediaPreviewUrl,
      })
      .from(userSettings)
      .where(eq(userSettings.oxyUserId, user));
    expect(row).toEqual({ trackId: null, artist: null, previewUrl: null });
  });

  it('unsets the pinned media entirely', async () => {
    const user = userId('profile-media-unset');
    await updateUserSettings(user, {
      set: {
        'profileCustomization.profileMedia': {
          type: 'song',
          syraTrackId: 'track-1',
          title: 'A song',
          artist: 'Someone',
          previewUrl: 'https://cdn.test/preview.mp3',
          startSec: 0,
        },
      },
    });

    const record = await updateUserSettings(user, {
      unset: { 'profileCustomization.profileMedia': '' },
    });

    expect(record.profileCustomization.profileMedia).toBeNull();
  });

  it('round-trips the For You feed tuning as one object', async () => {
    const user = userId('tuning');

    const record = await updateUserSettings(user, {
      set: {
        'feedTuning.forYou': {
          minLength: { enabled: true, minLength: 40 },
          minQuality: { enabled: true, minQuality: 0.3 },
        },
      },
    });

    expect(record.feedTuning?.forYou).toEqual({
      minLength: { enabled: true, minLength: 40 },
      minQuality: { enabled: true, minQuality: 0.3 },
    });
  });

  it('keeps label actions with their settings row', async () => {
    const user = userId('labels');
    await ensureUserSettings(user);

    await replaceLabelActions(user, [
      { labelerId: 'labeler-1', labelSlug: 'spoiler', action: 'warn' },
    ]);

    expect((await loadUserSettings(user))?.privacy.labelPreferences?.labelActions)
      .toEqual([{ labelerId: 'labeler-1', labelSlug: 'spoiler', action: 'warn' }]);
  });

  it('batches several users without cross-contaminating their label actions', async () => {
    const first = userId('batch-a');
    const second = userId('batch-b');
    await ensureUserSettings(first);
    await ensureUserSettings(second);
    await replaceLabelActions(first, [
      { labelerId: 'labeler-1', labelSlug: 'spoiler', action: 'hide' },
    ]);
    await updateUserSettings(second, { set: { 'privacy.showSensitiveContent': true } });

    const batch = await loadUserSettingsByIds([first, second]);

    expect(batch.get(first)?.privacy.labelPreferences?.labelActions).toHaveLength(1);
    expect(batch.get(second)?.privacy.labelPreferences?.labelActions).toEqual([]);
    expect(batch.get(second)?.privacy.showSensitiveContent).toBe(true);
  });
});

describe('user settings — a change is VISIBLE to the readers that enforce it', () => {
  it('reaches the sensitive-content gate through its own read path', async () => {
    // The bug, stated as a test. `loadShowSensitiveContent` is what every
    // discovery surface asks before relaxing the sensitivity gate; while the
    // writer was on Mongoose this returned `false` no matter what the user
    // chose, and nothing anywhere reported a problem.
    const user = userId('gate');
    expect(await loadShowSensitiveContent(user)).toBe(false);

    await updateUserSettings(user, { set: { 'privacy.showSensitiveContent': true } });

    expect(await loadShowSensitiveContent(user)).toBe(true);
  });

  it('takes the opt-in back away', async () => {
    const user = userId('gate-off');
    await updateUserSettings(user, { set: { 'privacy.showSensitiveContent': true } });

    await updateUserSettings(user, { set: { 'privacy.showSensitiveContent': false } });

    expect(await loadShowSensitiveContent(user)).toBe(false);
  });
});
