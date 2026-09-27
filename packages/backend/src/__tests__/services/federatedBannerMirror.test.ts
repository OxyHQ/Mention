/**
 * Federated banners are mirrored durably — against REAL rows.
 *
 * An actor resolve records the banner its source advertises; a sweep mirrors
 * due rows and retries every failure on a backoff (never terminal); a one-shot
 * script queues the accounts that have no banner. Only the mirror itself
 * (download + Oxy upload, covered in `mediaCacheDurableFailure.test.ts`) is
 * mocked.
 *
 * The sweep claims from the WHOLE `federated_banner_mirrors` table and the
 * script pages EVERY federated actor, so this file runs against its own
 * database (`isolatedDatabaseFiles.ts`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ mirror: vi.fn(), mediaWrites: true }));

vi.mock('../../connectors/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/identity')>()),
  mirrorFederatedBanner: h.mirror,
}));
vi.mock('../../services/mediaCache/oxyMediaStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/mediaCache/oxyMediaStore')>()),
  isMediaCacheEnabled: () => h.mediaWrites,
}));

import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { federatedActors, federatedBannerMirrors } from '../../db/schema/federation';
import { userSettings } from '../../db/schema/userProfile';
import { recordFederatedBanner } from '../../db/federation/bannerMirrorRepository';
import {
  PERMANENT_RETRY_MS,
  TRANSIENT_BACKOFF_BASE_MS,
  TRANSIENT_BACKOFF_MAX_MS,
  bannerRetryDelayMs,
  runFederatedBannerMirrors,
} from '../../services/federatedBannerMirror';
import { queueFederatedBannerMirrors } from '../../scripts/queueFederatedBannerMirrors';

let seq = 0;
const user = () => `oxy-banner-user-${(seq += 1)}`;

async function rowOf(oxyUserId: string) {
  const [row] = await getDb().select().from(federatedBannerMirrors).where(eq(federatedBannerMirrors.oxyUserId, oxyUserId));
  return row;
}

async function makeDue(oxyUserId: string) {
  await getDb().update(federatedBannerMirrors).set({ retryAt: new Date(Date.now() - 1_000) }).where(eq(federatedBannerMirrors.oxyUserId, oxyUserId));
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  h.mirror.mockReset().mockResolvedValue({ ok: true, permanent: false });
  h.mediaWrites = true;
  await getDb().delete(federatedBannerMirrors);
});

afterAll(async () => {
  await closePostgres();
});

describe('recording the advertised banner', () => {
  it('records a new banner as due, ignores the same URL, and re-arms a CHANGED one', async () => {
    const u = user();
    expect(await recordFederatedBanner({ oxyUserId: u, actorUri: 'https://a.example/users/u', bannerUrl: 'https://a.example/h1.png' })).toBe(true);
    expect(await rowOf(u)).toMatchObject({ state: 'pending', attempts: 0, sourceUrl: 'https://a.example/h1.png' });

    await getDb().update(federatedBannerMirrors).set({ state: 'failed', attempts: 3 }).where(eq(federatedBannerMirrors.oxyUserId, u));
    expect(await recordFederatedBanner({ oxyUserId: u, actorUri: 'https://a.example/users/u', bannerUrl: 'https://a.example/h1.png' })).toBe(false);
    expect(await rowOf(u)).toMatchObject({ state: 'failed', attempts: 3 });

    expect(await recordFederatedBanner({ oxyUserId: u, actorUri: 'https://a.example/users/u', bannerUrl: 'https://a.example/h2.png' })).toBe(true);
    expect(await rowOf(u)).toMatchObject({ state: 'pending', attempts: 0, sourceUrl: 'https://a.example/h2.png', lastFailure: null });
  });

  it('refuses a non-http banner URL', async () => {
    expect(await recordFederatedBanner({ oxyUserId: user(), actorUri: 'x', bannerUrl: 'data:image/png;base64,AAA' })).toBe(false);
  });
});

describe('the sweep', () => {
  it('mirrors a due banner and marks it mirrored', async () => {
    const u = user();
    await recordFederatedBanner({ oxyUserId: u, actorUri: 'https://a.example/users/u', bannerUrl: 'https://a.example/h.png' });

    expect(await runFederatedBannerMirrors()).toMatchObject({ claimed: 1, mirrored: 1, failed: 0 });
    expect(h.mirror).toHaveBeenCalledWith('https://a.example/h.png', u, 'https://a.example/users/u');
    expect(await rowOf(u)).toMatchObject({ state: 'mirrored', attempts: 0, leaseUntil: null });

    h.mirror.mockClear();
    await runFederatedBannerMirrors();
    expect(h.mirror).not.toHaveBeenCalled();
  });

  it('backs a TRANSIENT failure off exponentially, and keeps retrying it — never terminal', async () => {
    const u = user();
    await recordFederatedBanner({ oxyUserId: u, actorUri: 'a', bannerUrl: 'https://a.example/h.png' });
    h.mirror.mockResolvedValue({ ok: false, permanent: false, reason: 'upstream-error:503' });

    const before = Date.now();
    expect(await runFederatedBannerMirrors()).toMatchObject({ failed: 1, byReason: { 'upstream-error:503': 1 } });
    let row = await rowOf(u);
    expect(row).toMatchObject({ state: 'failed', attempts: 1, lastFailure: 'upstream-error:503', leaseUntil: null });
    expect(row.retryAt.getTime()).toBeGreaterThanOrEqual(before + TRANSIENT_BACKOFF_BASE_MS - 5_000);

    // Not due yet: nothing happens.
    h.mirror.mockClear();
    await runFederatedBannerMirrors();
    expect(h.mirror).not.toHaveBeenCalled();

    // Due again: retried, and the backoff grows.
    await makeDue(u);
    await runFederatedBannerMirrors();
    row = await rowOf(u);
    expect(row.attempts).toBe(2);
    expect(row.retryAt.getTime()).toBeGreaterThanOrEqual(Date.now() + 3 * TRANSIENT_BACKOFF_BASE_MS - 10_000);

    // And it still recovers once the host answers.
    h.mirror.mockResolvedValue({ ok: true, permanent: false });
    await makeDue(u);
    await runFederatedBannerMirrors();
    expect(await rowOf(u)).toMatchObject({ state: 'mirrored', attempts: 0, lastFailure: null });
  });

  it('retries a banner whose bytes are not a usable image once a day, not never', async () => {
    const u = user();
    await recordFederatedBanner({ oxyUserId: u, actorUri: 'a', bannerUrl: 'https://a.example/h.png' });
    h.mirror.mockResolvedValue({ ok: false, permanent: true, reason: 'not-media' });

    await runFederatedBannerMirrors();
    const row = await rowOf(u);
    expect(row).toMatchObject({ state: 'failed', lastFailure: 'not-media' });
    expect(row.retryAt.getTime()).toBeGreaterThan(Date.now() + PERMANENT_RETRY_MS - 60_000);
  });

  it('does not settle a row whose URL changed while it was being mirrored', async () => {
    const u = user();
    await recordFederatedBanner({ oxyUserId: u, actorUri: 'a', bannerUrl: 'https://a.example/old.png' });
    h.mirror.mockImplementation(async () => {
      await recordFederatedBanner({ oxyUserId: u, actorUri: 'a', bannerUrl: 'https://a.example/new.png' });
      return { ok: true, permanent: false };
    });

    await runFederatedBannerMirrors();
    expect(await rowOf(u)).toMatchObject({ state: 'pending', sourceUrl: 'https://a.example/new.png' });
  });

  it('does nothing while media writes are off (it would only burn attempts)', async () => {
    const u = user();
    await recordFederatedBanner({ oxyUserId: u, actorUri: 'a', bannerUrl: 'https://a.example/h.png' });
    h.mediaWrites = false;

    expect(await runFederatedBannerMirrors()).toMatchObject({ claimed: 0 });
    expect(h.mirror).not.toHaveBeenCalled();
    expect(await rowOf(u)).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it('two sweeps never claim the same row', async () => {
    const users = Array.from({ length: 6 }, () => user());
    for (const u of users) await recordFederatedBanner({ oxyUserId: u, actorUri: 'a', bannerUrl: `https://a.example/${u}.png` });
    h.mirror.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, permanent: false };
    });

    const [a, b] = await Promise.all([runFederatedBannerMirrors({ limit: 4 }), runFederatedBannerMirrors({ limit: 4 })]);
    expect(a.claimed + b.claimed).toBe(6);
    expect(h.mirror).toHaveBeenCalledTimes(6);
  });

  it('bounds the backoff', () => {
    expect(bannerRetryDelayMs(1, false)).toBe(TRANSIENT_BACKOFF_BASE_MS);
    expect(bannerRetryDelayMs(2, false)).toBe(3 * TRANSIENT_BACKOFF_BASE_MS);
    expect(bannerRetryDelayMs(20, false)).toBe(TRANSIENT_BACKOFF_MAX_MS);
    expect(bannerRetryDelayMs(1, true)).toBe(PERMANENT_RETRY_MS);
  });
});

describe('queueFederatedBannerMirrors (recovery)', () => {
  async function seedActor(n: number, opts: { headerUrl?: string; oxyUserId?: string; storedBanner?: string }) {
    const uri = `https://r.example/users/banner${n}`;
    await getDb().insert(federatedActors).values({
      protocol: 'activitypub',
      uri,
      username: `banner${n}`,
      domain: 'r.example',
      acct: `banner${n}@r.example`,
      inboxUrl: `${uri}/inbox`,
      type: 'Person',
      headerUrl: opts.headerUrl,
      oxyUserId: opts.oxyUserId,
      lastFetchedAt: new Date(),
    });
    if (opts.oxyUserId && opts.storedBanner) {
      await getDb().insert(userSettings).values({ oxyUserId: opts.oxyUserId, profileHeaderImage: opts.storedBanner })
        .onConflictDoUpdate({ target: userSettings.oxyUserId, set: { profileHeaderImage: opts.storedBanner } });
    }
    return uri;
  }

  beforeAll(async () => {
    await getDb().delete(federatedActors).where(sql`${federatedActors.uri} like 'https://r.example/users/banner%'`);
    await seedActor(1, { headerUrl: 'https://r.example/h1.png', oxyUserId: 'oxy-banner-q1' });
    await seedActor(2, { headerUrl: 'https://r.example/h2.png', oxyUserId: 'oxy-banner-q2', storedBanner: 'already-there' });
    await seedActor(3, { headerUrl: 'https://r.example/h3.png' }); // not linked to an Oxy user
    await seedActor(4, { oxyUserId: 'oxy-banner-q4' }); // no banner advertised
    await seedActor(5, { headerUrl: 'data:image/png;base64,AAA', oxyUserId: 'oxy-banner-q5' });
  });

  it('a dry run counts and writes nothing', async () => {
    expect(await queueFederatedBannerMirrors({ dryRun: true })).toMatchObject({ actors: 2, withoutBanner: 1, queued: 0 });
    expect(await rowOf('oxy-banner-q1')).toBeUndefined();
  });

  it('queues only the accounts with no stored banner — and INCLUDE_EXISTING re-syncs the rest', async () => {
    expect(await queueFederatedBannerMirrors({ dryRun: false })).toMatchObject({ queued: 1 });
    expect(await rowOf('oxy-banner-q1')).toMatchObject({ state: 'pending', sourceUrl: 'https://r.example/h1.png' });
    expect(await rowOf('oxy-banner-q2')).toBeUndefined();

    // Idempotent.
    expect(await queueFederatedBannerMirrors({ dryRun: false })).toMatchObject({ queued: 0 });

    expect(await queueFederatedBannerMirrors({ dryRun: false, includeExisting: true })).toMatchObject({ queued: 1 });
    expect(await rowOf('oxy-banner-q2')).toMatchObject({ state: 'pending' });
  });

  it('RETRY_FAILED makes every failed row due now, backoff reset', async () => {
    await recordFederatedBanner({ oxyUserId: 'oxy-banner-q1', actorUri: 'a', bannerUrl: 'https://r.example/h1.png' });
    await getDb().update(federatedBannerMirrors)
      .set({ state: 'failed', attempts: 5, retryAt: new Date(Date.now() + 86_400_000) })
      .where(eq(federatedBannerMirrors.oxyUserId, 'oxy-banner-q1'));

    expect(await queueFederatedBannerMirrors({ dryRun: true, retryFailed: true })).toMatchObject({ failedDue: 1, retried: 0 });
    expect(await queueFederatedBannerMirrors({ dryRun: false, retryFailed: true })).toMatchObject({ retried: 1 });
    const row = await rowOf('oxy-banner-q1');
    expect(row.attempts).toBe(0);
    expect(row.retryAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });
});
