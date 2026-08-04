import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { userSettings } from '../db/schema/userProfile';
import { ensureUserSettings, updateUserSettings } from '../db/userProfile/userSettingsRepository';
import { loadShowSensitiveContent } from '../services/safety/viewerSafety';

/**
 * `privacy.showSensitiveContent` — the gate every read surface consults before
 * showing a viewer someone else's sensitive post.
 *
 * This used to construct a Mongoose document and read the schema default off
 * it, which asserted a fact about a model nothing loads any more. The default
 * now lives in the COLUMN (`privacy_show_sensitive_content boolean not null
 * default false`), so the only way to state it is to insert a row that mentions
 * nothing and read back what the database chose.
 *
 * The safe default is the whole point: a user who has never opened settings, or
 * whose row does not exist at all, must not be shown sensitive content. Both are
 * asserted, because they are different code paths — a column default and a
 * missing-row read — and only the first is visible in the schema.
 */

const PREFIX = 'user-settings-sensitive';
const created: string[] = [];

/** A viewer id unique to this file: suites share one database and run in parallel. */
function viewer(name: string): string {
  const id = `${PREFIX}-${name}`;
  created.push(id);
  return id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  while (created.length > 0) {
    const id = created.pop();
    if (id) await getDb().delete(userSettings).where(eq(userSettings.oxyUserId, id));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('privacy.showSensitiveContent', () => {
  it('defaults to false on a row created with nothing but the user id', async () => {
    const record = await ensureUserSettings(viewer('fresh'));
    expect(record.privacy?.showSensitiveContent).toBe(false);
  });

  it('reads false for a viewer who has no settings row at all', async () => {
    // The un-onboarded viewer. `loadShowSensitiveContent` is the ONE reader every
    // surface goes through, and a missing row must answer the same as an unset
    // preference — not `undefined`, which a caller would treat as truthy-ish.
    expect(await loadShowSensitiveContent(viewer('absent'))).toBe(false);
  });

  it('round-trips an explicit true, and the reader honours it', async () => {
    const id = viewer('opted-in');
    await ensureUserSettings(id);
    await updateUserSettings(id, { set: { 'privacy.showSensitiveContent': true } });

    const record = await ensureUserSettings(id);
    expect(record.privacy?.showSensitiveContent).toBe(true);
    expect(await loadShowSensitiveContent(id)).toBe(true);
  });

  it('round-trips an explicit false', async () => {
    const id = viewer('opted-out');
    await ensureUserSettings(id);
    await updateUserSettings(id, { set: { 'privacy.showSensitiveContent': true } });
    await updateUserSettings(id, { set: { 'privacy.showSensitiveContent': false } });

    expect(await loadShowSensitiveContent(id)).toBe(false);
  });

  it('is NOT NULL, so no row can leave the gate undecided', async () => {
    // The column carries the guarantee the old schema default only implied: a
    // writer cannot store "unknown" and leave a read surface to guess.
    const id = viewer('null-write');
    await ensureUserSettings(id);
    await expect(
      getDb()
        .update(userSettings)
        .set({ privacyShowSensitiveContent: null as unknown as boolean })
        .where(eq(userSettings.oxyUserId, id)),
    ).rejects.toThrow();
  });
});
