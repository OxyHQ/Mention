import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, like, sql } from 'drizzle-orm';

/**
 * The one-shot federated @mention repair, against REAL rows.
 *
 * The sweep re-fetches a federated post's source Note, re-resolves its mentions
 * lookup-only, and writes back the repaired body plus the mention allowlist.
 * `signedFetch` is stubbed per source URL — that is a network call, not a store —
 * and everything else it touches is a real table, so the REAL selection filter,
 * paging, resume cursor, mention resolution, placeholder rewrite, body
 * re-derivation and write all run.
 *
 * ## What the Postgres port changed, and why the shape of the suite changed with it
 *
 * The previous version mocked `models/Post` over an in-memory array and
 * hand-implemented a Mongo filter interpreter so the mock could evaluate the
 * script's ACTUAL filter. That was the right call while the filter was a plain
 * object; it cannot survive the port, because the filter is now a drizzle `SQL`
 * expression that only Postgres can evaluate — and a mock that kept answering
 * would have made every selection assertion here a statement about the
 * interpreter rather than about the query.
 *
 * Three properties are consequently asserted DIFFERENTLY, and each is stronger:
 *
 *  - **Selection** is asserted by seeding rows and reading back which ids the
 *    run scanned, so a weakened clause changes the answer.
 *  - **The write shape** was `store.ops` — a Mongo `$set` whitelist. In Postgres
 *    that property becomes: the body and the mention set changed, and the
 *    media, attachments and localized alt text did NOT. `content.variants` was
 *    ONE document field, so Mongo's `$set` of the whole array was correct; the
 *    variants are a child table with rows other tables reference BY ID, and
 *    `replacePostContent` — the function that looks like the answer — clears
 *    media, attachments and sources on its way past. `preserves a post's media,
 *    attachments and localized alt text` is the test for that, and it is new.
 *  - **Idempotency** is asserted by running twice against the real filter: a
 *    repaired post must LEAVE the candidate set. Under the old harness this
 *    depended on the hand-written interpreter agreeing with Mongo.
 *
 * `actor.service` is mocked purely so the test can ASSERT it is never called —
 * the repair must resolve lookup-only and can never mint a ghost actor. The
 * cursor and failure-log doubles sit at the REPOSITORY (whose own behaviour
 * against real rows is covered by `adminScriptCursor.test.ts`), so the wiring
 * under test — which scope a run reads, when it writes, whether a dry run writes
 * at all — actually runs.
 */

/** A stored `admin_script_cursors` row — where one shard scope got to. */
interface StoredCursor {
  script: string;
  scope: string;
  cursor: string;
  scanned: number;
  completedAt: Date | null;
}

/** A stored `repair_fetch_failures` row — why one post's re-fetch failed. */
interface StoredFailure {
  script: string;
  postId: string;
  reason: string;
  status?: number;
  failedAt: Date;
}

const mocks = vi.hoisted(() => {
  const store: {
    cursors: StoredCursor[];
    /** Every cursor value written, in order — the per-page persistence itself. */
    cursorWrites: { scope: string; cursor: string; scanned: number; completed: boolean }[];
    /** Set to make the next cursor write fail, like a database blip would. */
    cursorWriteError: Error | null;
    failureLog: StoredFailure[];
    /** Set to make the next failure-log write fail. */
    failureLogWriteError: Error | null;
  } = {
    cursors: [],
    cursorWrites: [],
    cursorWriteError: null,
    failureLog: [],
    failureLogWriteError: null,
  };

  return {
    store,
    signedFetch: vi.fn(),
    findExistingActor: vi.fn(),
    getOrFetchActor: vi.fn(),
    /**
     * A minimal `admin_script_cursors` table with the REPOSITORY's own upsert
     * semantics, so the REAL cursor helper runs against it rather than being
     * stubbed out. Mocking the helper instead would leave the wiring — which
     * scope a run reads, when it writes, whether a dry run writes at all —
     * untested, and that wiring is the entire fix.
     */
    cursorRepository: {
      findAdminScriptCursor: vi.fn(async (script: string, scope: string) =>
        store.cursors.find((row) => row.script === script && row.scope === scope) ?? null,
      ),
      upsertAdminScriptCursor: vi.fn(async (
        script: string,
        scope: string,
        update: { cursor: string; scanned: number; completed?: boolean },
      ) => {
        if (store.cursorWriteError) throw store.cursorWriteError;
        store.cursorWrites.push({
          scope,
          cursor: update.cursor,
          scanned: update.scanned,
          completed: update.completed === true,
        });
        const completedAt = update.completed ? new Date() : null;
        const existing = store.cursors.find(
          (row) => row.script === script && row.scope === scope,
        );
        if (existing) {
          Object.assign(existing, { cursor: update.cursor, scanned: update.scanned, completedAt });
        } else {
          store.cursors.push({
            script,
            scope,
            cursor: update.cursor,
            scanned: update.scanned,
            completedAt,
          });
        }
      }),
      deleteAdminScriptCursor: vi.fn(async (script: string, scope: string) => {
        store.cursors = store.cursors.filter(
          (row) => !(row.script === script && row.scope === scope),
        );
      }),
    },
    /**
     * A minimal `repair_fetch_failures` table with the repository's UPSERT
     * semantics, so the bound the table relies on — one row per distinct failing
     * post, not one per failure — is actually exercised rather than asserted
     * about a double that appends unconditionally.
     */
    failureRepository: {
      recordRepairFetchFailures: vi.fn(async (
        script: string,
        failures: readonly Omit<StoredFailure, 'script'>[],
      ) => {
        if (store.failureLogWriteError) throw store.failureLogWriteError;
        for (const failure of failures) {
          const existing = store.failureLog.find(
            (row) => row.script === script && row.postId === failure.postId,
          );
          // Upsert, and `status` is REPLACED rather than merged: a post that
          // failed with a 403 and now times out really has no status, and
          // carrying the old one forward would say the origin refused again.
          if (existing) Object.assign(existing, { status: undefined, ...failure });
          else store.failureLog.push({ script, ...failure });
        }
      }),
    },
  };
});

vi.mock('../../db/adminScripts/adminScriptStateRepository', () => ({
  ...mocks.cursorRepository,
  ...mocks.failureRepository,
}));

vi.mock('../../connectors/activitypub/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/activitypub/helpers')>()),
  // Only the network call is stubbed; `runWithTimeout`, `extractApMedia`,
  // `extractApHashtags` et al. stay REAL so the re-derivation under test is the
  // one production runs.
  signedFetch: mocks.signedFetch,
}));

/**
 * The lookup-only actor resolve. Doubled at the REPOSITORY, which is where it
 * lives now — the point of the assertions below is that this sweep resolves an
 * ALREADY-STORED actor and can never fetch or mint one, and that is a property
 * of which function it calls rather than of what the row contains.
 */
vi.mock('../../db/federation/actorRepository', () => ({
  findActorByUri: mocks.findExistingActor,
  findActorByAcct: mocks.findExistingActor,
}));

vi.mock('../../connectors/activitypub/actor.service', () => ({
  actorService: { getOrFetchActor: mocks.getOrFetchActor },
}));

// Media materialization is network + S3; the body re-derivation under test never
// calls it, but it is imported at module load.
vi.mock('../../connectors/shared/federatedMedia', () => ({
  materializeFederatedMedia: vi.fn(async (media: unknown[], attachments: unknown[]) => ({
    media,
    attachments,
  })),
}));

import { PostType, PostVisibility, type PostContentVariant } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { insertPostRecord, loadPostRecord } from '../../db/posts/postRepository';
import type { PostRecordInput } from '../../db/posts/postRecord';
import { posts } from '../../db/schema/posts';
import {
  postContentVariants,
  postMedia,
  postVariantAltTexts,
} from '../../db/schema/postContent';
import {
  assertRepairRunComplete,
  buildCandidateFilter,
  buildCursorScope,
  repairFederatedMentions,
  resolveSourceUrl,
  SCRIPT_NAME,
  type CandidatePostRow,
  type RepairFederatedMentionsSummary,
} from '../../scripts/repairFederatedMentions';
import { logger } from '../../utils/logger';

const { store } = mocks;

/** The `logger.warn` calls the run emitted, as `[message, context]` pairs. */
function warnCalls(): [string, Record<string, unknown>][] {
  return vi.mocked(logger.warn).mock.calls as [string, Record<string, unknown>][];
}

/**
 * This file's private id namespace.
 *
 * Every id is a 24-character hex ObjectId, because two tests pass one as a shard
 * BOUND and `parseIdBound` refuses anything that is not a live entity id. The
 * prefix is hex but distinctive, so the whole set is reachable by one `LIKE` in
 * teardown — one database serves the parallel run and a bare `delete from posts`
 * would take another file's rows mid-assertion. The suffix keeps ASCENDING TEXT
 * order, which is the order the sweep pages in.
 */
const ID_PREFIX = 'facade00000000000000';
const oid = (suffix: string): string => `${ID_PREFIX}${suffix.padStart(4, '0')}`;

/** The federated author every fixture post is attributed to. */
const AUTHOR_OXY_ID = 'oxy-repairfedmentions-author';
const MENTIONED_OXY_ID = 'oxy_indigoparadox';

/**
 * The real Mastodon SAME-INSTANCE shape, verbatim from the toot that surfaced
 * the bug: the `Mention` tag `name` is the BARE `@user` (no `@domain`, because
 * author and mentioned user share an instance) while the in-content anchor points
 * at the human profile URL.
 */
const SAME_INSTANCE_NOTE = {
  type: 'Note',
  id: 'https://mastodon.social/users/Gargron/statuses/117016521955489722',
  content:
    '<p><span class="h-card" translate="no"><a href="https://mastodon.social/@indigoparadox" class="u-url mention">@<span>indigoparadox</span></a></span> No, none of that.</p>',
  tag: [
    {
      type: 'Mention',
      href: 'https://mastodon.social/users/indigoparadox',
      name: '@indigoparadox',
    },
  ],
};

/** The body the OLD ingest stored: the anchor stripped to dead `@user` text. */
const DAMAGED_TEXT = '@indigoparadox No, none of that.';
/** What the repair must land on: the internal placeholder hydration renders. */
const REPAIRED_TEXT = `[mention:${MENTIONED_OXY_ID}] No, none of that.`;

/** The ActivityPub OBJECT ID — the URL that answers `application/activity+json`. */
const OBJECT_ID = SAME_INSTANCE_NOTE.id;
/** The HUMAN web page permalink — serves HTML on plenty of servers. */
const WEB_PAGE_URL = 'https://mastodon.social/@Gargron/117016521955489722';

/**
 * A DISTINCT object id and web page per fixture.
 *
 * `posts.federation_activity_id` is UNIQUE — Mongo declared no such index, so
 * the previous in-memory store happily held ten posts sharing one activity id.
 * Two fixture posts are two federated posts, and two federated posts cannot be
 * the same AP object, so the fixtures say so.
 */
const objectIdFor = (suffix: string): string =>
  `https://mastodon.social/users/Gargron/statuses/9000000000000000${suffix.padStart(4, '0')}`;
const webPageFor = (suffix: string): string =>
  `https://mastodon.social/@Gargron/9000000000000000${suffix.padStart(4, '0')}`;

/**
 * Seed one federated post.
 *
 * Every fixture carries BOTH `activityId` and `url` on purpose: preferring the
 * web page is what made a production dry run reject 40 of 50 fetches on
 * content-type, so "both present" is the case that has to keep choosing the
 * object id.
 */
async function seedPost(
  suffix: string,
  overrides: Partial<PostRecordInput> = {},
  activityId = objectIdFor(suffix),
): Promise<string> {
  const id = oid(suffix);
  await insertPostRecord({
    id,
    oxyUserId: AUTHOR_OXY_ID,
    authorship: [{ oxyUserId: AUTHOR_OXY_ID, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', tag: 'en', text: DAMAGED_TEXT }] },
    federation: {
      activityId,
      actorUri: 'https://mastodon.social/users/Gargron',
      url: webPageFor(suffix),
    },
    ...overrides,
  });
  return id;
}

/** A damaged, repairable post — the primary fixture. */
async function seedDamaged(suffix: string, activityId = objectIdFor(suffix)): Promise<string> {
  return seedPost(suffix, {}, activityId);
}

/** The stored variants of one post, in position order. */
async function storedVariants(id: string): Promise<PostContentVariant[]> {
  return (await loadPostRecord(id))?.content.variants ?? [];
}

/** The stored mention allowlist of one post. */
async function storedMentions(id: string): Promise<string[]> {
  return (await loadPostRecord(id))?.mentions ?? [];
}

/** Every id this file seeded that now carries a resolved mention set. */
async function repairedIds(): Promise<string[]> {
  const rows = await getDb()
    .select({ id: posts.id })
    .from(posts)
    .where(like(posts.id, `${ID_PREFIX}%`))
    .orderBy(asc(posts.id));
  const repaired: string[] = [];
  for (const row of rows) {
    if ((await storedMentions(row.id)).length > 0) repaired.push(row.id);
  }
  return repaired;
}

/** Build an AP JSON response the way an origin server would answer. */
function apResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/activity+json' },
  });
}

/** A `CandidatePostRow` carrying only the federation fields under test. */
function candidateRow(federation: CandidatePostRow['federation']): CandidatePostRow {
  return { id: oid('1'), mentions: [], variants: [], hasMedia: false, federation };
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  await getDb().delete(posts).where(like(posts.id, `${ID_PREFIX}%`));
  store.cursors = [];
  store.cursorWrites = [];
  store.cursorWriteError = null;
  store.failureLog = [];
  store.failureLogWriteError = null;
  mocks.failureRepository.recordRepairFetchFailures.mockClear();
  mocks.cursorRepository.findAdminScriptCursor.mockClear();
  mocks.cursorRepository.upsertAdminScriptCursor.mockClear();
  mocks.cursorRepository.deleteAdminScriptCursor.mockClear();
  mocks.signedFetch.mockReset();
  mocks.getOrFetchActor.mockReset();
  mocks.findExistingActor.mockReset();
  vi.mocked(logger.warn).mockClear();

  // The mentioned actor IS already stored — the only shape the lookup-only
  // resolver can resolve.
  mocks.findExistingActor.mockResolvedValue({ oxyUserId: MENTIONED_OXY_ID });
  // A fresh `Response` per call — a WHATWG body can only be read once, so a
  // shared `mockResolvedValue` would make every post after the first fail.
  mocks.signedFetch.mockImplementation(async () => apResponse(SAME_INSTANCE_NOTE));
});

afterEach(async () => {
  await getDb().delete(posts).where(like(posts.id, `${ID_PREFIX}%`));
});

afterAll(async () => {
  await closePostgres();
});

describe('buildCandidateFilter', () => {
  /** The ids the filter selects, in the order the sweep would page them. */
  async function selected(actorUri?: string): Promise<string[]> {
    const rows = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(buildCandidateFilter(actorUri))
      .orderBy(asc(posts.id));
    return rows.map((row) => row.id).filter((id) => id.startsWith(ID_PREFIX));
  }

  it('selects federated non-boost posts with no mentions and an @-shaped body', async () => {
    const damaged = await seedDamaged('1');

    // A NATIVE post — no federation activity id.
    await seedPost('2', { federation: undefined });
    // A BOOST, which carries no body of its own to repair.
    await seedPost('3', { type: PostType.BOOST });
    // Already resolved: one mention row is the single state that means it.
    await seedPost('4', { mentions: ['oxy_bob'] });
    // No `@`-shaped residue anywhere in the body.
    await seedPost('5', {
      content: { variants: [{ source: 'author', tag: 'en', text: 'no mentions here at all' }] },
    });
    // The OTHER damage shape the one regex has to catch: the raw profile URL a
    // plain-text-child anchor degrades to.
    const rawUrl = await seedPost('6', {
      content: {
        variants: [{ source: 'author', tag: 'en', text: 'hey https://mastodon.social/@alice look' }],
      },
    });

    expect(await selected()).toEqual([damaged, rawUrl]);
  });

  it('narrows to a single origin actor when one is supplied', async () => {
    const mine = await seedDamaged('1');
    await seedPost('2', {
      federation: {
        activityId: 'https://other.example/notes/2',
        actorUri: 'https://other.example/users/someone',
        url: 'https://other.example/@someone/2',
      },
    });

    expect(await selected()).toEqual([mine, oid('2')]);
    expect(await selected('https://mastodon.social/users/Gargron')).toEqual([mine]);
  });
});

describe('resolveSourceUrl', () => {
  it('prefers the ActivityPub object id over the human web page', () => {
    // `federation.url` is Mastodon's `/@user/<id>` permalink, which a great many
    // servers serve as HTML whatever the `Accept` header says. `activityId` IS
    // the AP object — the URL federation itself dereferences.
    expect(resolveSourceUrl(candidateRow({ activityId: OBJECT_ID, url: WEB_PAGE_URL }))).toEqual({
      url: OBJECT_ID,
      kind: 'activityId',
    });
  });

  it('falls back to the web page url only when the object id is absent', () => {
    expect(resolveSourceUrl(candidateRow({ url: WEB_PAGE_URL }))).toEqual({
      url: WEB_PAGE_URL,
      kind: 'url',
    });
  });

  it('returns null when the post carries neither', () => {
    expect(resolveSourceUrl(candidateRow({}))).toBeNull();
  });
});

describe('repairFederatedMentions', () => {
  it('dereferences the object id, never the human web page, when both are present', async () => {
    await seedDamaged('1');

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.repaired).toBe(1);
    expect(mocks.signedFetch).toHaveBeenCalledTimes(1);
    expect(mocks.signedFetch.mock.calls[0][0]).toBe(objectIdFor('1'));
    // The regression that failed 40 of 50 posts in production.
    expect(mocks.signedFetch).not.toHaveBeenCalledWith(webPageFor('1'), expect.anything());
  });

  it('re-links a same-instance mention the old ingest stripped to dead text', async () => {
    const id = await seedDamaged('1');

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.candidates).toBe(1);
    expect(summary.repaired).toBe(1);
    expect(summary.written).toBe(1);
    expect(summary.unresolved).toBe(0);

    // The body carries the internal placeholder, and the stored language tag and
    // `source` survive — a mention repair must not re-decide what language the
    // body is in.
    expect(await storedVariants(id)).toEqual([
      { source: 'author', tag: 'en', text: REPAIRED_TEXT },
    ]);
    expect(await storedMentions(id)).toEqual([MENTIONED_OXY_ID]);

    // Lookup-only: a bulk sweep must never fetch or MINT a federated actor.
    expect(mocks.getOrFetchActor).not.toHaveBeenCalled();
    expect(mocks.findExistingActor).toHaveBeenCalledWith(
      'https://mastodon.social/users/indigoparadox',
    );
  });

  it('preserves a post\'s media, attachments and localized alt text', async () => {
    // The write shape, restated for a child table. `content.variants` was ONE
    // document field, so Mongo's `$set` of the whole array was correct; here the
    // variants are ROWS that `post_variant_media` and `post_variant_alt_texts`
    // reference BY ID, and `replacePostContent` — the function that looks like
    // the answer — clears media, attachments and sources on its way past. A body
    // repair that reached for it would silently drop a post's media links and its
    // localized alt text, with no error anywhere.
    const id = await seedPost('1', {
      content: {
        variants: [{ source: 'author', tag: 'en', text: DAMAGED_TEXT, alt: { 'file-1': 'a cat' } }],
        media: [{ id: 'file-1', type: 'image' }],
      },
    });
    const db = getDb();
    const [variantBefore] = await db
      .select({ id: postContentVariants.id })
      .from(postContentVariants)
      .where(eq(postContentVariants.postId, id));
    const [altBefore] = await db
      .select({ id: postVariantAltTexts.id, description: postVariantAltTexts.description })
      .from(postVariantAltTexts)
      .where(eq(postVariantAltTexts.variantId, variantBefore.id));
    expect(altBefore.description).toBe('a cat');

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });
    expect(summary.repaired).toBe(1);

    // The body moved…
    const variantsAfter = await db
      .select({ id: postContentVariants.id, body: postContentVariants.body })
      .from(postContentVariants)
      .where(eq(postContentVariants.postId, id));
    expect(variantsAfter).toEqual([{ id: variantBefore.id, body: REPAIRED_TEXT }]);

    // …and nothing that hangs off the variant ROW moved with it.
    expect(
      await db
        .select({ id: postVariantAltTexts.id, description: postVariantAltTexts.description })
        .from(postVariantAltTexts)
        .where(eq(postVariantAltTexts.variantId, variantBefore.id)),
    ).toEqual([altBefore]);
    expect(
      await db.select({ mediaId: postMedia.mediaId }).from(postMedia).where(eq(postMedia.postId, id)),
    ).toEqual([{ mediaId: 'file-1' }]);
  });

  it('never selects a post whose mentions are already resolved', async () => {
    await seedPost('2', {
      mentions: ['oxy_bob'],
      content: { variants: [{ source: 'author', text: '[mention:oxy_bob] hi @carol' }] },
      federation: {
        activityId: 'https://remote.example/notes/2',
        actorUri: 'https://remote.example/users/x',
        url: 'https://remote.example/notes/2',
      },
    });

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.candidates).toBe(0);
    expect(summary.scanned).toBe(0);
    expect(mocks.signedFetch).not.toHaveBeenCalled();
  });

  it('is idempotent — a second run over a repaired corpus updates nothing', async () => {
    const id = await seedDamaged('1');

    const first = await repairFederatedMentions({ noteTimeoutMs: 1_000 });
    expect(first.repaired).toBe(1);
    expect(await storedMentions(id)).toEqual([MENTIONED_OXY_ID]);
    expect((await storedVariants(id))[0].text).toBe(REPAIRED_TEXT);

    mocks.signedFetch.mockClear();

    const second = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    // The repaired post has left the candidate set entirely: nothing scanned,
    // nothing re-fetched, nothing written.
    expect(second.candidates).toBe(0);
    expect(second.scanned).toBe(0);
    expect(second.repaired).toBe(0);
    expect(second.written).toBe(0);
    expect(mocks.signedFetch).not.toHaveBeenCalled();
  });

  it('skips a 410 Gone origin without aborting the run or deleting the post', async () => {
    const goneObjectId = 'https://dead.example/users/x/statuses/gone';
    const healthy = await seedDamaged('1');
    const gone = await seedDamaged('2', goneObjectId);
    mocks.signedFetch.mockImplementation(async (url: string) =>
      url === goneObjectId ? new Response(null, { status: 410 }) : apResponse(SAME_INSTANCE_NOTE),
    );

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.scanned).toBe(2);
    expect(summary.gone).toBe(1);
    // The healthy post in the SAME page is still repaired — one dead origin
    // never aborts the sweep.
    expect(summary.repaired).toBe(1);
    expect(await repairedIds()).toEqual([healthy]);
    // The gone post keeps its stored body — a removed upstream is never a reason
    // to blank or delete a local copy.
    expect((await storedVariants(gone))[0].text).toBe(DAMAGED_TEXT);
  });

  it('leaves a transiently unreachable origin for a later re-run', async () => {
    const deadObjectId = 'https://offline.example/users/x/statuses/1';
    const healthy = await seedDamaged('1');
    const dead = await seedDamaged('2', deadObjectId);
    mocks.signedFetch.mockImplementation(async (url: string) => {
      if (url === deadObjectId) throw new Error('ECONNREFUSED');
      return apResponse(SAME_INSTANCE_NOTE);
    });

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.fetchFailed).toBe(1);
    expect(summary.repaired).toBe(1);
    expect(await repairedIds()).toEqual([healthy]);
    // Still a candidate, so the next run picks it up again.
    expect(await storedMentions(dead)).toEqual([]);
  });

  it('does not churn a body that is already correct — it writes only the allowlist', async () => {
    // The `@` that made this post a candidate is an EMAIL ADDRESS, and the body
    // already carries the placeholder; only the `mentions` allowlist is missing.
    // The re-derived body therefore equals the stored one, so its ROW must not be
    // rewritten (no version churn across the whole corpus, no risk to the tag).
    const note = {
      ...SAME_INSTANCE_NOTE,
      content: SAME_INSTANCE_NOTE.content.replace(
        'No, none of that.',
        'No, none of that. mail@example.com',
      ),
    };
    mocks.signedFetch.mockImplementation(async () => apResponse(note));

    const id = await seedPost('1', {
      content: {
        variants: [{ source: 'author', tag: 'en', text: `${REPAIRED_TEXT} mail@example.com` }],
      },
    });
    // `xmin` is the transaction that last WROTE the row, so it distinguishes
    // "the row is unchanged" from "the row was rewritten with the same bytes".
    // Nothing else can: the variants table carries no `updated_at`, so a
    // re-write that lands the identical body is invisible in every column.
    const variantRows = () =>
      getDb()
        .select({ id: postContentVariants.id, body: postContentVariants.body, xmin: sql<string>`xmin` })
        .from(postContentVariants)
        .where(eq(postContentVariants.postId, id));
    const before = await variantRows();

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.repaired).toBe(1);
    expect(await storedMentions(id)).toEqual([MENTIONED_OXY_ID]);
    // Not merely equal — NOT REWRITTEN.
    expect(await variantRows()).toEqual(before);
  });

  it('logs ONE structured warn naming the URL, the field it came from, and the cause', async () => {
    // The production dry run could not be diagnosed at all: the failure warn
    // carried only the error, so nothing said WHICH url was attempted or WHAT
    // the origin served. This is the regression test for that.
    await seedDamaged('1');
    mocks.signedFetch.mockImplementation(async () => {
      throw new Error('ActivityPub response has unsupported content-type: text/html');
    });

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.fetchFailed).toBe(1);

    const failures = warnCalls().filter(
      ([message]) => message === '[repairFederatedMentions] source re-fetch failed',
    );
    expect(failures).toHaveLength(1);
    expect(failures[0][1]).toEqual({
      source: objectIdFor('1'),
      sourceKind: 'activityId',
      reason: 'transport',
      status: undefined,
      contentType: undefined,
      // The media type the transport observed, so the operator sees "HTML" and
      // not merely "not JSON".
      detail: 'ActivityPub response has unsupported content-type: text/html',
    });
  });

  it('surfaces the HTTP status and the served media type on a bad status', async () => {
    await seedDamaged('1');
    mocks.signedFetch.mockImplementation(
      async () =>
        new Response('<html>rate limited</html>', {
          status: 429,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    );

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.fetchFailedByReason).toEqual({
      timeout: 0,
      transport: 0,
      httpStatus: 1,
      nonObjectPayload: 0,
      malformedJson: 0,
    });
    const [, context] = warnCalls().find(
      ([message]) => message === '[repairFederatedMentions] source re-fetch failed',
    ) as [string, Record<string, unknown>];
    expect(context.status).toBe(429);
    // Parameters dropped — the family is what identifies the problem.
    expect(context.contentType).toBe('text/html');
  });

  it('returns the exact post and URL of each failure for in-process review', async () => {
    const deadObjectId = 'https://offline.example/users/x/statuses/1';
    const id = await seedDamaged('1', deadObjectId);
    mocks.signedFetch.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    // The log reduces a URL to its host and redacts a 24-hex ObjectId outright,
    // so the returned record is the only place carrying both in full.
    expect(summary.failures).toEqual([
      {
        id,
        source: deadObjectId,
        sourceKind: 'activityId',
        reason: 'transport',
        status: undefined,
        contentType: undefined,
        detail: 'ECONNREFUSED',
      },
    ]);
  });

  it('classifies a JSON body that is not an object, and caps collected failures', async () => {
    await seedDamaged('1');
    await seedDamaged('2', 'https://a.example/users/x/statuses/2');
    mocks.signedFetch.mockImplementation(
      async () =>
        new Response('["not an object"]', {
          status: 200,
          headers: { 'content-type': 'application/activity+json' },
        }),
    );

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000, failureSampleSize: 1 });

    expect(summary.fetchFailed).toBe(2);
    expect(summary.fetchFailedByReason.nonObjectPayload).toBe(2);
    // Counted in full, collected up to the cap.
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].reason).toBe('nonObjectPayload');
    expect(summary.failures[0].contentType).toBe('application/activity+json');
  });

  it('counts a note whose mentions resolve to nobody as unresolved, writing nothing', async () => {
    const id = await seedDamaged('1');
    // No stored federated actor row for the mentioned account.
    mocks.findExistingActor.mockResolvedValue(null);

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.unresolved).toBe(1);
    expect(summary.repaired).toBe(0);
    expect(summary.written).toBe(0);
    expect(await storedMentions(id)).toEqual([]);
    expect((await storedVariants(id))[0].text).toBe(DAMAGED_TEXT);
    expect(mocks.getOrFetchActor).not.toHaveBeenCalled();
  });

  it('writes NOTHING under dryRun, while reporting the plan and a before/after sample', async () => {
    const id = await seedDamaged('1');

    const summary = await repairFederatedMentions({ dryRun: true, noteTimeoutMs: 1_000 });

    expect(summary.dryRun).toBe(true);
    expect(summary.repaired).toBe(1);
    expect(summary.written).toBe(0);
    // The stored row is untouched.
    expect(await storedMentions(id)).toEqual([]);
    expect((await storedVariants(id))[0].text).toBe(DAMAGED_TEXT);

    // The preview reports exactly what a real run would write, JSON-quoted so the
    // placeholder is visible.
    expect(summary.samples).toEqual([
      {
        id,
        before: JSON.stringify(DAMAGED_TEXT),
        after: JSON.stringify(REPAIRED_TEXT),
        mentions: [MENTIONED_OXY_ID],
      },
    ]);
  });

  it('honours the scan limit and pages by an ascending id cursor', async () => {
    const first = await seedDamaged('1');
    const second = await seedDamaged('2');
    const third = await seedDamaged('3');

    const summary = await repairFederatedMentions({ limit: 2, batchSize: 1, noteTimeoutMs: 1_000 });

    expect(summary.candidates).toBe(3);
    expect(summary.scanned).toBe(2);
    expect(summary.repaired).toBe(2);
    expect(await repairedIds()).toEqual([first, second]);
    expect(await storedMentions(third)).toEqual([]);
  });
});

/**
 * The resume cursor, which is the difference between a killed sweep being
 * continued and being restarted.
 *
 * Restarting is not merely slower: the candidate filter only stops matching a
 * post once it is REPAIRED, so every `unresolved`, `gone` and `fetchFailed` post
 * keeps matching forever at the LOWEST ids. Measured in production on
 * 2026-08-01, a restart re-walked a 9,466-post stuck head for 51 repairs (0.5%)
 * — nine thousand requests to other people's servers that could not succeed.
 * Every assertion below is ultimately about that: `signedFetch` call counts are
 * requests to somebody else's server.
 *
 * The cursor is exercised through a doubled REPOSITORY rather than a mocked
 * helper, so the wiring under test — which scope a run reads, when it writes,
 * and whether a dry run writes at all — actually runs.
 */
describe('resume cursor', () => {
  /** An id with hex LETTERS in it, so case canonicalisation is observable. */
  const LETTERED_ID = '65fdc8c8c8c8c8c8c8c8c8c8';

  /** A stored cursor for `scope`, as a killed run would have left it. */
  function storedCursor(scope: string, cursor: string, scanned: number): StoredCursor {
    return { script: SCRIPT_NAME, scope, cursor, scanned, completedAt: null };
  }

  it('records the cursor after EVERY page, not once at the end', async () => {
    await seedDamaged('1');
    await seedDamaged('2');
    await seedDamaged('3');

    const summary = await repairFederatedMentions({ batchSize: 1, noteTimeoutMs: 1_000 });

    // A run that dies never reaches its final summary, so a cursor written only
    // at the end could not survive the one case it exists for.
    expect(store.cursorWrites).toEqual([
      { scope: summary.cursorScope, cursor: oid('1'), scanned: 1, completed: false },
      { scope: summary.cursorScope, cursor: oid('2'), scanned: 2, completed: false },
      { scope: summary.cursorScope, cursor: oid('3'), scanned: 3, completed: false },
      // The empty page that ends the sweep: the range is exhausted, so the scope
      // is stamped finished rather than merely paused.
      { scope: summary.cursorScope, cursor: oid('3'), scanned: 3, completed: true },
    ]);
    expect(store.cursors).toEqual([{
      script: SCRIPT_NAME,
      scope: summary.cursorScope,
      cursor: oid('3'),
      scanned: 3,
      completedAt: expect.any(Date),
    }]);
  });

  it('leaves the scope unfinished when the run stopped on its limit', async () => {
    await seedDamaged('1');
    await seedDamaged('2');
    await seedDamaged('3');

    await repairFederatedMentions({ limit: 2, batchSize: 1, noteTimeoutMs: 1_000 });

    // Stopping on a budget is not finishing, and a scope wrongly stamped
    // complete would read as "nothing left to do" forever.
    expect(store.cursorWrites.map((write) => write.completed)).toEqual([false, false]);
    expect(store.cursors[0]).toMatchObject({ cursor: oid('2'), completedAt: null });
  });

  it('resumes past everything the previous run visited instead of restarting', async () => {
    const stuck = await seedDamaged('1');
    await seedDamaged('2');
    const remaining = await seedDamaged('3');
    store.cursors = [storedCursor(buildCursorScope({}), oid('2'), 2)];

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.resumed).toBe(true);
    expect(summary.resumedFromScanned).toBe(2);
    expect(summary.scanned).toBe(1);
    // Counted within the resumed range, so the run reports the work it has LEFT.
    expect(summary.candidates).toBe(1);
    expect(await repairedIds()).toEqual([remaining]);
    // The whole point: the stuck head is not re-fetched from its origin.
    expect(mocks.signedFetch).toHaveBeenCalledTimes(1);
    expect(await storedMentions(stuck)).toEqual([]);
  });

  it('reads the cursor under a DRY RUN but never advances it', async () => {
    await seedDamaged('1');
    await seedDamaged('2');
    await seedDamaged('3');
    store.cursors = [storedCursor(buildCursorScope({}), oid('1'), 1)];

    const summary = await repairFederatedMentions({ dryRun: true, noteTimeoutMs: 1_000 });

    // Reading is what makes a preview show what the next LIVE run would do.
    expect(summary.resumed).toBe(true);
    expect(summary.scanned).toBe(2);
    // Writing would make that live run skip exactly the posts just previewed.
    expect(store.cursorWrites).toEqual([]);
    expect(store.cursors[0]).toMatchObject({ cursor: oid('1'), scanned: 1 });
  });

  it('keeps each shard scope separate, so parallel shards never resume each other', async () => {
    await seedDamaged('1');
    await seedDamaged('2');
    const third = await seedDamaged('3');
    const fourth = await seedDamaged('4');
    // Shard A — ids up to 2 — has already finished its territory.
    store.cursors = [{
      ...storedCursor(buildCursorScope({ beforeId: oid('2') }), oid('2'), 2),
      completedAt: new Date(),
    }];

    // Shard B — ids 3 and 4 — must be untouched by any of that.
    const summary = await repairFederatedMentions({
      afterId: oid('2'),
      beforeId: oid('4'),
      noteTimeoutMs: 1_000,
    });

    expect(summary.resumed).toBe(false);
    expect(summary.scanned).toBe(2);
    expect(await repairedIds()).toEqual([third, fourth]);
    expect(store.cursors).toHaveLength(2);
    expect(store.cursorWrites.every((write) => write.scope === summary.cursorScope)).toBe(true);
  });

  it('separates shards that differ only in their upper bound', async () => {
    await seedDamaged('1');
    await seedDamaged('2');
    await seedDamaged('3');
    await seedDamaged('4');
    // A narrow shard covering ids up to 2 has run to the end of its range.
    store.cursors = [storedCursor(buildCursorScope({ beforeId: oid('2') }), oid('2'), 2)];

    // A WIDER shard from the same lower bound is a different territory. Sharing
    // a scope with the narrow one would make it skip ids 1 and 2 outright —
    // invisible in every counter, because it would report a clean resumed run.
    const summary = await repairFederatedMentions({
      beforeId: oid('4'),
      noteTimeoutMs: 1_000,
    });

    expect(summary.resumed).toBe(false);
    expect(summary.scanned).toBe(4);
  });

  it('treats a differently-spelled bound as the SAME shard, not a second one', async () => {
    await seedDamaged('1');

    const canonical = await repairFederatedMentions({
      afterId: LETTERED_ID,
      dryRun: true,
      noteTimeoutMs: 1_000,
    });
    const spelledDifferently = await repairFederatedMentions({
      afterId: `  ${LETTERED_ID.toUpperCase()}  `,
      dryRun: true,
      noteTimeoutMs: 1_000,
    });

    // Two spellings of one shard resolving to two scopes would leave each
    // re-walking the other's ground while both looked resumed.
    expect(spelledDifferently.cursorScope).toBe(canonical.cursorScope);
    // Vacuity floor: the scope really carries the canonicalised bound, rather
    // than both spellings collapsing to some constant.
    expect(canonical.cursorScope).toContain(LETTERED_ID);
  });

  it('refuses to run when the stored cursor lies outside the declared range', async () => {
    await seedDamaged('1');
    await seedDamaged('2');
    await seedDamaged('3');
    const scope = buildCursorScope({ afterId: oid('1'), beforeId: oid('2') });
    store.cursors = [storedCursor(scope, oid('3'), 3)];

    // Resuming from it would either skip a stretch of the corpus or re-walk a
    // neighbouring shard, and both are invisible in the counters.
    await expect(repairFederatedMentions({
      afterId: oid('1'),
      beforeId: oid('2'),
      noteTimeoutMs: 1_000,
    })).rejects.toThrow(/outside this run's declared _id range/);
    expect(mocks.signedFetch).not.toHaveBeenCalled();
  });

  it('starts the shard again, once, when the cursor is explicitly reset', async () => {
    await seedDamaged('1');
    await seedDamaged('2');
    await seedDamaged('3');
    store.cursors = [storedCursor(buildCursorScope({}), oid('2'), 2)];

    const summary = await repairFederatedMentions({ resetCursor: true, noteTimeoutMs: 1_000 });

    expect(summary.resumed).toBe(false);
    expect(summary.resumedFromScanned).toBe(0);
    expect(summary.scanned).toBe(3);
    expect(mocks.cursorRepository.deleteAdminScriptCursor).toHaveBeenCalledWith(
      SCRIPT_NAME,
      summary.cursorScope,
    );
  });

  it('counts a cursor write that did not land, and fails the run for it', async () => {
    await seedDamaged('1');
    store.cursorWriteError = new Error('connection reset by peer');

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    // The sweep itself is unharmed — a database blip must not kill a six-hour
    // run that is repairing posts correctly.
    expect(summary.repaired).toBe(1);
    expect(summary.written).toBe(1);
    // But it is never swallowed: the damage lands on the NEXT run, which would
    // silently restart at the beginning.
    expect(summary.cursorWriteFailures).toBe(2);
    expect(() => assertRepairRunComplete(summary)).toThrow('cursorNotPersisted=2');
  });
});

/**
 * The per-post failure log, which is what makes retrying the transient tail
 * cheap enough to ever be worth doing.
 *
 * The candidate filter cannot tell a briefly-unreachable origin from a mentioned
 * actor we have never stored or an origin that answered 410. Measured on the
 * real corpus, that is 5,691 retryable posts inside 46,291 candidates — so
 * retrying THROUGH the filter costs ~40,600 requests to other people's servers
 * that cannot produce a repair, and the correct decision was not to. These rows
 * are what turn that into an indexed query instead.
 */
describe('re-fetch failure log', () => {
  /** An origin that is briefly unreachable — the retryable shape. */
  function rateLimited(): Response {
    return new Response('<html>rate limited</html>', {
      status: 429,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  it('records every failed post with the reason and status a retry selects on', async () => {
    await seedDamaged('1');
    await seedDamaged('2');
    mocks.signedFetch.mockImplementation(async () => rateLimited());

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.fetchFailed).toBe(2);
    expect(store.failureLog).toEqual([
      {
        script: SCRIPT_NAME,
        postId: oid('1'),
        reason: 'httpStatus',
        // 429 is worth coming back to; 403 would not be. Dropping the status
        // would make a polite retry indistinguishable from an impolite one.
        status: 429,
        failedAt: expect.any(Date),
      },
      {
        script: SCRIPT_NAME,
        postId: oid('2'),
        reason: 'httpStatus',
        status: 429,
        failedAt: expect.any(Date),
      },
    ]);
  });

  it('records ALL failures, not just the bounded reading sample', async () => {
    for (let index = 1; index <= 5; index += 1) await seedDamaged(String(index));
    mocks.signedFetch.mockImplementation(async () => rateLimited());

    const summary = await repairFederatedMentions({ failureSampleSize: 2, noteTimeoutMs: 1_000 });

    // A log capped at the sample size would be targeting two posts, not a tail.
    expect(summary.failures).toHaveLength(2);
    expect(store.failureLog).toHaveLength(5);
  });

  it('keeps one row per post however many runs re-fail it', async () => {
    await seedDamaged('1');
    mocks.signedFetch.mockImplementation(async () => rateLimited());

    await repairFederatedMentions({ resetCursor: true, noteTimeoutMs: 1_000 });
    await repairFederatedMentions({ resetCursor: true, noteTimeoutMs: 1_000 });

    // Upserted, not appended: the table is bounded by DISTINCT failing posts,
    // and the targeting query cannot return the same post twice.
    expect(store.failureLog).toHaveLength(1);
  });

  it('records nothing at all under a DRY RUN', async () => {
    await seedDamaged('1');
    mocks.signedFetch.mockImplementation(async () => rateLimited());

    const summary = await repairFederatedMentions({ dryRun: true, noteTimeoutMs: 1_000 });

    expect(summary.fetchFailed).toBe(1);
    // A dry run promises to write NOTHING. Rows left behind by a preview are the
    // same broken promise as a cursor quietly advanced by one.
    expect(store.failureLog).toEqual([]);
    expect(mocks.failureRepository.recordRepairFetchFailures).not.toHaveBeenCalled();
  });

  it('records the page\'s failures BEFORE advancing the cursor past them', async () => {
    await seedDamaged('1');
    await seedDamaged('2');
    mocks.signedFetch.mockImplementation(async () => rateLimited());
    const order: string[] = [];
    mocks.failureRepository.recordRepairFetchFailures.mockImplementationOnce(async () => {
      order.push('failures');
    });
    mocks.cursorRepository.upsertAdminScriptCursor.mockImplementationOnce(async () => {
      order.push('cursor');
    });

    await repairFederatedMentions({ batchSize: 1, noteTimeoutMs: 1_000 });

    // If the cursor advanced first and the task were killed, a resumed run would
    // start PAST posts whose failures were never recorded — losing them from the
    // targeting set for good. This way the worst case is a re-walked page, which
    // the repair is idempotent against.
    expect(order).toEqual(['failures', 'cursor']);
  });

  it('counts failures it could not record, and fails the run for them', async () => {
    await seedDamaged('1');
    await seedDamaged('2');
    mocks.signedFetch.mockImplementation(async () => rateLimited());
    store.failureLogWriteError = new Error('connection reset by peer');

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.failuresNotRecorded).toBe(2);
    // Costs this run nothing; costs the next one the only cheap route back to
    // those posts.
    expect(() => assertRepairRunComplete(summary)).toThrow('failuresNotRecorded=2');
  });
});

/**
 * Which counters reach the completion guard, and in which bucket. The guard's own
 * threshold arithmetic is covered by `adminRunTolerance.test.ts`; this pins the
 * WIRING, which is the part specific to this sweep and the part a future edit
 * could silently get wrong by dropping a strict counter into the tolerated bucket.
 */
describe('assertRepairRunComplete', () => {
  /** A clean summary of a 600-post run — the shape of the production dry run. */
  function summaryOf(overrides: Partial<RepairFederatedMentionsSummary> = {}): RepairFederatedMentionsSummary {
    const byReason = {
      timeout: 0,
      transport: 0,
      httpStatus: 0,
      nonObjectPayload: 0,
      malformedJson: 0,
      ...(overrides.fetchFailedByReason ?? {}),
    };
    return {
      dryRun: true,
      candidates: 164969,
      scanned: 600,
      repaired: 288,
      unchanged: 0,
      unresolved: 260,
      gone: 40,
      skippedNoSource: 0,
      skippedEmptyBody: 0,
      written: 0,
      lastScannedId: null,
      cursorScope: buildCursorScope({}),
      resumed: false,
      resumedFromScanned: 0,
      cursorWriteFailures: 0,
      failuresNotRecorded: 0,
      samples: [],
      failures: [],
      ...overrides,
      // Derived last so the per-reason merge above always wins, and the total
      // defaults to agreeing with it unless a case deliberately desyncs the two.
      fetchFailedByReason: byReason,
      fetchFailed:
        overrides.fetchFailed
        ?? Object.values(byReason).reduce((total, value) => total + value, 0),
    };
  }

  it('accepts the measured production run: 12 unreachable origins in 600 scanned (2%)', () => {
    expect(() =>
      assertRepairRunComplete(
        summaryOf({ fetchFailedByReason: { transport: 3, httpStatus: 9 } }),
      ),
    ).not.toThrow();
  });

  it('treats `gone` and `unresolved` as terminal outcomes, never as failures', () => {
    // 40 tombstoned origins and 260 mentions of actors we have never stored is
    // the lookup-only resolver working exactly as designed. Neither is handed to
    // the guard at all — a run of nothing but these must still pass.
    expect(() =>
      assertRepairRunComplete(summaryOf({ gone: 600, unresolved: 600, repaired: 0 })),
    ).not.toThrow();
  });

  it('fails once unreachable origins pass the stated ceiling', () => {
    // The pre-fix production run, which dereferenced the human web page: 80%.
    expect(() =>
      assertRepairRunComplete(summaryOf({ fetchFailedByReason: { httpStatus: 480 } })),
    ).toThrow(/remoteUnavailable=480 \(80\.00% of 600 scanned, over the 10\.00% allowed/);
  });

  it('fails on a SINGLE unparseable payload — our side is never a matter of rate', () => {
    expect(() =>
      assertRepairRunComplete(
        summaryOf({ fetchFailedByReason: { transport: 3, httpStatus: 9, malformedJson: 1 } }),
      ),
    ).toThrow('malformedPayload=1');

    expect(() =>
      assertRepairRunComplete(summaryOf({ fetchFailedByReason: { nonObjectPayload: 1 } })),
    ).toThrow('malformedPayload=1');
  });

  it('fails on a single candidate with no source URL — the filter guarantees one', () => {
    expect(() => assertRepairRunComplete(summaryOf({ skippedNoSource: 1 }))).toThrow(
      'skippedNoSource=1',
    );
  });

  it('fails on a single cursor write that did not persist', () => {
    // Costs this run nothing — which is exactly why it must fail here. The
    // damage lands on the NEXT run, which restarts at the beginning and
    // re-fetches the whole stuck head from other people's servers.
    expect(() => assertRepairRunComplete(summaryOf({ cursorWriteFailures: 1 }))).toThrow(
      'cursorNotPersisted=1',
    );
  });

  it('fails on a single failure it could not record for a later retry', () => {
    expect(() => assertRepairRunComplete(summaryOf({ failuresNotRecorded: 1 }))).toThrow(
      'failuresNotRecorded=1',
    );
  });

  it('fails on a single empty re-derive — the filter guarantees a stored body', () => {
    expect(() => assertRepairRunComplete(summaryOf({ skippedEmptyBody: 1 }))).toThrow(
      'skippedEmptyBody=1',
    );
  });

  it('fails STRICTLY on a failure that landed in no reason bucket', () => {
    // Vacuity guard: a future path incrementing the total without classifying it
    // must surface here, not vanish into a bucket it was never measured against.
    expect(() =>
      assertRepairRunComplete(
        summaryOf({ fetchFailed: 20, fetchFailedByReason: { httpStatus: 9 } }),
      ),
    ).toThrow('unclassifiedFetchFailure=11');
  });
});
