/**
 * `GET /search?type=posts` — the post-search query, against REAL ROWS.
 *
 * ## Why this is a rewrite and not an adaptation
 *
 * The previous version mocked `models/Post` and asserted on the FILTER OBJECT the
 * handler built: `expect(find).toHaveBeenCalledWith({ $text: … })`. That is an
 * assertion about a data structure, and it cannot distinguish a filter that
 * selects the right posts from one that selects none — which is the failure mode
 * that actually ships. Every assertion here names a post that was written in the
 * same test and checks whether search returns it.
 *
 * ## The two properties that are easy to lose in this port
 *
 * **The order is CHRONOLOGICAL, not ranked.** Mongo's text index on
 * `content.variants.text` was single-field, so every match scored identically
 * and `sort({createdAt:-1,_id:-1})` decided the whole order. Postgres offers
 * `ts_rank`, and adding it — or per-lexeme weights — would silently reorder the
 * wire response for every existing client. `ranks a term-dense post below a
 * newer sparse one` is the test that catches it.
 *
 * **`(created_at DESC, id DESC)` is already a strict total order**, so the
 * keyset needs no third key. What it DOES need is for the id half to work
 * across the cutover: `posts.id` is `text`, holding pre-cutover ObjectId hex
 * next to uuid v7, and `'0' < '6'` means every uuid sorts BELOW every ObjectId.
 * A pagination test seeded with one id shape passes against a broken tie-break,
 * so the walk below seeds both.
 *
 * ## What is stubbed, and why only this
 *
 * Oxy is a foreign HTTP service (`getProfileByUsername` for `from:`/`to:`,
 * `getUserFollowing` for an `exclude-following` mute), so it is a stub.
 * `PostHydrationService` is stubbed too — hydration is its own suite's subject —
 * but the stub DERIVES its DTO from the record search actually selected, so the
 * muted-word filter still runs against the stored body, hashtags and author.
 * Everything else is real: `posts`, `post_content_variants`, `post_media`,
 * `post_mentions`, `post_authorships`, `user_settings` and `mute_words`.
 */

import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

const mocks = vi.hoisted(() => ({
  getProfileByUsername: vi.fn(),
  getUserFollowing: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: () => ({ getUserFollowing: mocks.getUserFollowing }),
  getServiceOxyClient: () => undefined,
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ getProfileByUsername: mocks.getProfileByUsername }),
}));

/**
 * Hydration, reduced to the three fields the muted-word filter reads — taken
 * from the record the QUERY returned, never invented.
 *
 * A stub that answered with a canned list would make every assertion below an
 * assertion about the stub. This one can only ever describe posts search
 * actually selected, so `posts[0].content.text` naming the right row is evidence
 * about the query.
 */
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: {
    hydratePosts: vi.fn(async (records: Array<Record<string, never>>) =>
      records.map((record) => {
        const post = record as unknown as {
          id: string;
          oxyUserId: string | null;
          hashtags: string[];
          content: { variants?: Array<{ text?: string }> };
        };
        return {
          id: post.id,
          content: { text: post.content.variants?.[0]?.text ?? '' },
          metadata: { hashtags: post.hashtags },
          user: { id: post.oxyUserId },
        };
      }),
    ),
  },
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { muteWords } from '../../db/schema/engagement';
import { posts } from '../../db/schema/posts';
import { userSettings } from '../../db/schema/userProfile';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import type { PostRecordInput } from '../../db/posts/postRecord';
import searchRoutes from '../../routes/search';

const scope = postScope('search-posts');
const VIEWER = scope.user('viewer');

/**
 * A nonsense token no other suite's fixture body contains, so the shared
 * database cannot leak another file's public posts into these pages. It has to
 * survive `to_tsvector('english', …)` as one lexeme, so it is a bare word.
 */
const TERM = 'zorblattic';

const app = express();
app.use((req, _res, next) => {
  (req as express.Request & { user?: { id: string } }).user = { id: VIEWER };
  next();
});
app.use('/search', searchRoutes);

/** The same router with no session, for the anonymous-viewer paths. */
const anonApp = express();
anonApp.use('/search', searchRoutes);

/** A post whose body carries {@link TERM}, so only this file's rows can match. */
function body(text: string): PostRecordInput['content'] {
  return { variants: [{ source: 'author', text: `${TERM} ${text}`, tag: 'en' }] };
}

interface SearchBody {
  posts: Array<{ id: string; content?: { text?: string } }>;
  hasMore: boolean;
  nextCursor?: string;
}

async function search(
  query: Record<string, string | number>,
  agent = app,
): Promise<SearchBody> {
  const res = await request(agent).get('/search').query({ type: 'posts', ...query }).expect(200);
  return res.body as SearchBody;
}

/** Just the ids a page returned, in wire order. */
async function idsFor(query: Record<string, string | number>, agent = app): Promise<string[]> {
  return (await search(query, agent)).posts.map((post) => post.id);
}

/**
 * Set a post's like/boost counters directly.
 *
 * `PostRecordInput` deliberately carries no `stats` — the counters are a
 * projection `PostEngagementCommandService` maintains with the rows they
 * project. Search only READS them, so writing the column is the honest fixture
 * here; going through the engagement service would seed a different suite's
 * subject to test this one.
 */
async function setCounters(
  postId: string,
  counters: { likes?: number; boosts?: number },
): Promise<void> {
  await getDb()
    .update(posts)
    .set({
      ...(counters.likes === undefined ? {} : { statsLikesCount: counters.likes }),
      ...(counters.boosts === undefined ? {} : { statsBoostsCount: counters.boosts }),
    })
    .where(eq(posts.id, postId));
}

const mutedUserIds: string[] = [];
const settingsUserIds: string[] = [];

async function mute(
  userId: string,
  rule: { value: string; targets: string[]; actorTarget?: 'all' | 'exclude-following' },
): Promise<void> {
  await getDb().insert(muteWords).values({
    userId,
    value: rule.value,
    targets: rule.targets,
    actorTarget: rule.actorTarget ?? 'all',
  });
  mutedUserIds.push(userId);
}

async function optInToSensitive(userId: string): Promise<void> {
  await getDb().insert(userSettings).values({
    oxyUserId: userId,
    privacyShowSensitiveContent: true,
  });
  settingsUserIds.push(userId);
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUserFollowing.mockResolvedValue([]);
});

afterEach(async () => {
  await clearPostScope(scope);
  const db = getDb();
  if (mutedUserIds.length > 0) {
    await db.delete(muteWords).where(inArray(muteWords.userId, mutedUserIds.splice(0)));
  }
  if (settingsUserIds.length > 0) {
    await db.delete(userSettings).where(inArray(userSettings.oxyUserId, settingsUserIds.splice(0)));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('GET /search — what the query selects', () => {
  it('returns only public, published posts matching the text', async () => {
    const visible = await seedPost(scope, { content: body('a public published post') });
    await seedPost(scope, { content: body('private'), visibility: PostVisibility.PRIVATE });
    await seedPost(scope, {
      content: body('followers only'),
      visibility: PostVisibility.FOLLOWERS_ONLY,
    });
    await seedPost(scope, { content: body('a draft'), status: 'draft' });
    await seedPost(scope, { content: body('restricted'), status: 'restricted' });
    // Matches nothing: it carries the fixture prefix but not the searched word.
    await seedPost(scope, { content: body('unrelated') });

    expect(await idsFor({ query: `${TERM} published` })).toEqual([visible.id]);
  });

  it('matches a non-primary rendition, because the vector is per variant', async () => {
    // The Spanish translation carries the term; the primary does not. Mongo's
    // text index covered `content.variants.text` as a multikey path, so this
    // matched there too — an EXISTS over one variant row is the port of that,
    // and a predicate bound to `position = 0` would silently narrow it.
    const translated = await seedPost(scope, {
      content: {
        variants: [
          { source: 'author', text: `${TERM} primary rendition`, tag: 'en' },
          { source: 'machine', text: `${TERM} traducción cafetera`, tag: 'es' },
        ],
      },
    });
    await seedPost(scope, { content: body('primary rendition only') });

    expect(await idsFor({ query: 'cafetera' })).toEqual([translated.id]);
  });

  it('treats a regex-looking query as text rather than a pattern', async () => {
    // `websearch_to_tsquery` cannot raise a syntax error, which is why it is the
    // parser here: a user typing punctuation gets no results, never a 500.
    const post = await seedPost(scope, { content: body('hello world') });

    expect(await idsFor({ query: `${TERM} hello .* world` })).toEqual([post.id]);
  });

  it('returns every public post when no text is supplied', async () => {
    // No free text means no text predicate at all — the browse case. Narrowed
    // to the viewer's own posts, because a database shared by the whole
    // parallel run has no other bound on "everything public".
    const solo = await seedPost(scope, {
      oxyUserId: VIEWER,
      authorship: [{ oxyUserId: VIEWER, role: 'owner', status: 'accepted' }],
      content: body('browse'),
    });

    expect(await idsFor({ query: 'from:me', limit: 50 })).toEqual([solo.id]);
  });
});

describe('GET /search — order and pagination', () => {
  it('ranks a term-dense post below a newer sparse one', async () => {
    // The whole no-`ts_rank` guarantee in one test. `dense` repeats the term
    // eight times and would win any relevance ordering; `sparse` is newer and
    // must come first, because the order is chronological.
    const dense = await seedPost(scope, {
      content: body(`${`${TERM} `.repeat(8)}dense`),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const sparse = await seedPost(scope, {
      content: body('sparse'),
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    expect(await idsFor({ query: TERM })).toEqual([sparse.id, dense.id]);
  });

  it('walks every post exactly once across id shapes that interleave', async () => {
    // The four ids share ONE `createdAt`, so `created_at DESC` cannot separate
    // them and the whole walk rests on the `id DESC` tie-break. Two are
    // pre-cutover ObjectId hex and two are uuid v7 — under text collation every
    // uuid ('0…') sorts below every ObjectId ('6…'), which is precisely the
    // interleaving a same-shape fixture cannot reproduce.
    const SAME = new Date('2026-02-01T00:00:00.000Z');
    const ids = [
      '65fdc8c8c8c8c8c8c8c8c8c8',
      '65fdc8c8c8c8c8c8c8c8c8c9',
      '019616a0-0000-7000-8000-00000000000a',
      '019616a0-0000-7000-8000-00000000000b',
    ];
    for (const id of ids) {
      await seedPost(scope, { id, content: body('paged'), createdAt: SAME });
    }

    // Page size THREE, not two, and that is load-bearing. At two, page one ends
    // on `65fd…c8` — a valid ObjectId — and page two needs no cursor at all, so
    // the walk never asks the encoder to describe a uuid and passes against an
    // encoder that cannot. At three the first page ends on a uuid, which is the
    // anchor every page after the cutover actually has.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const body_: SearchBody = await search({
        query: `${TERM} paged`,
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...body_.posts.map((post) => post.id));
      if (!body_.hasMore) break;
      expect(body_.nextCursor).toBeTruthy();
      cursor = body_.nextCursor;
    }

    expect(seen).toEqual([...ids].sort().reverse());
    expect(new Set(seen).size).toBe(ids.length);
  });

  it('reports hasMore only when a further page exists', async () => {
    await seedPost(scope, { content: body('one') });
    await seedPost(scope, { content: body('two') });

    expect((await search({ query: `${TERM}`, limit: 2 })).hasMore).toBe(false);
    expect((await search({ query: `${TERM}`, limit: 1 })).hasMore).toBe(true);
  });

  it('rejects a legacy or malformed cursor instead of restarting page one', async () => {
    const post = await seedPost(scope, { content: body('cursorless') });

    await request(app)
      .get('/search')
      .query({ type: 'posts', cursor: '65fdc8c8c8c8c8c8c8c8c8c8' })
      .expect(400, { message: 'Invalid search cursor' });

    // The 400 is worth having only because page one WOULD have returned rows —
    // a handler that silently restarted would look identical to a caller.
    expect(await idsFor({ query: `${TERM} cursorless` })).toEqual([post.id]);
  });
});

describe('GET /search — operators', () => {
  it('matches from: against accepted authorship, not the denormalized owner', async () => {
    const collaborator = scope.user('collab');
    const owner = scope.user('owner');
    const collab = await seedPost(scope, {
      oxyUserId: owner,
      authorship: [
        { oxyUserId: owner, role: 'owner', status: 'accepted' },
        { oxyUserId: collaborator, role: 'collaborator', status: 'accepted' },
      ],
      content: body('collaborative'),
    });
    // A PENDING invite is not authorship: the invitee has not consented, so
    // their `from:` must not surface the post.
    await seedPost(scope, {
      oxyUserId: owner,
      authorship: [
        { oxyUserId: owner, role: 'owner', status: 'accepted' },
        { oxyUserId: collaborator, role: 'collaborator', status: 'pending' },
      ],
      content: body('pending invite'),
    });
    mocks.getProfileByUsername.mockResolvedValue({ id: collaborator });

    expect(await idsFor({ query: `${TERM} from:alice` })).toEqual([collab.id]);
    expect(mocks.getProfileByUsername).toHaveBeenCalledWith('alice');
  });

  it('strips a leading @ so from:@alice and from:alice name the same account', async () => {
    const author = scope.user('at-author');
    const post = await seedPost(scope, {
      oxyUserId: author,
      authorship: [{ oxyUserId: author, role: 'owner', status: 'accepted' }],
      content: body('handled'),
    });
    mocks.getProfileByUsername.mockResolvedValue({ id: author });

    expect(await idsFor({ query: `${TERM} from:@alice` })).toEqual([post.id]);
    // Handed a literal `@alice`, Oxy resolves nobody and the search answers "no
    // posts" — which reads as an empty account, not as bad input.
    expect(mocks.getProfileByUsername).toHaveBeenCalledWith('alice');
  });

  it('resolves from:me to the viewer without asking Oxy for an account named "me"', async () => {
    const mine = await seedPost(scope, {
      oxyUserId: VIEWER,
      authorship: [{ oxyUserId: VIEWER, role: 'owner', status: 'accepted' }],
      content: body('mine'),
    });
    await seedPost(scope, { content: body('someone elses') });

    expect(await idsFor({ query: `${TERM} from:me` })).toEqual([mine.id]);
    expect(mocks.getProfileByUsername).not.toHaveBeenCalled();
  });

  it('returns nothing rather than everything when from:me has no viewer', async () => {
    await seedPost(scope, { content: body('public to all') });

    const page = await search({ query: `${TERM} from:me` }, anonApp);

    // A DROPPED filter would answer a different question than the one asked,
    // and would look like a working search returning the whole corpus.
    expect(page).toEqual({ posts: [], hasMore: false });
  });

  it('returns nothing rather than dropping the filter when to: names an unknown user', async () => {
    await seedPost(scope, { content: body('mentions nobody') });
    mocks.getProfileByUsername.mockResolvedValue(null);

    expect(await search({ query: `${TERM} to:nobody` })).toEqual({ posts: [], hasMore: false });
  });

  it('matches to: against the resolved mention allowlist', async () => {
    const mentioned = scope.user('mentioned');
    const withMention = await seedPost(scope, {
      content: body('deadline'),
      mentions: [mentioned],
    });
    await seedPost(scope, { content: body('deadline elsewhere') });
    mocks.getProfileByUsername.mockResolvedValue({ id: mentioned });

    expect(await idsFor({ query: `${TERM} to:@alice deadline` })).toEqual([withMention.id]);
  });

  it('resolves to:me to the viewer', async () => {
    const atMe = await seedPost(scope, { content: body('for you'), mentions: [VIEWER] });
    await seedPost(scope, { content: body('for someone else'), mentions: ['oxy-other'] });

    expect(await idsFor({ query: `${TERM} to:me` })).toEqual([atMe.id]);
    expect(mocks.getProfileByUsername).not.toHaveBeenCalled();
  });

  it('combines from: and to: into one conjunctive filter', async () => {
    const other = scope.user('other');
    const both = await seedPost(scope, {
      oxyUserId: VIEWER,
      authorship: [{ oxyUserId: VIEWER, role: 'owner', status: 'accepted' }],
      content: body('both'),
      mentions: [other],
    });
    // Each of these satisfies exactly one half, so an OR would return them.
    await seedPost(scope, {
      oxyUserId: VIEWER,
      authorship: [{ oxyUserId: VIEWER, role: 'owner', status: 'accepted' }],
      content: body('mine only'),
    });
    await seedPost(scope, { content: body('mentions only'), mentions: [other] });
    mocks.getProfileByUsername.mockResolvedValue({ id: other });

    expect(await idsFor({ query: `${TERM} from:me to:alice` })).toEqual([both.id]);
    expect(mocks.getProfileByUsername).toHaveBeenCalledTimes(1);
  });

  it('selects has:media by a real media row, and mediaType by its type', async () => {
    const withVideo = await seedPost(scope, {
      type: PostType.VIDEO,
      content: {
        ...body('clip'),
        media: [{ id: 'file-video-1', type: 'video' }],
      },
    });
    const withImage = await seedPost(scope, {
      type: PostType.IMAGE,
      content: {
        ...body('photo'),
        media: [{ id: 'file-image-1', type: 'image' }],
      },
    });
    const textOnly = await seedPost(scope, { content: body('words only') });

    expect((await idsFor({ query: `${TERM} has:media`, limit: 50 })).sort())
      .toEqual([withImage.id, withVideo.id].sort());
    expect(await idsFor({ query: TERM, mediaType: 'video', limit: 50 })).toEqual([withVideo.id]);
    expect(await idsFor({ query: `${TERM} has:media`, limit: 50 })).not.toContain(textOnly.id);
  });

  it('selects has:links from the stored flag rather than scanning the body', async () => {
    const linked = await seedPost(scope, { content: body('see https://example.test'), hasLinks: true });
    await seedPost(scope, { content: body('no link here') });

    expect(await idsFor({ query: `${TERM} has:links` })).toEqual([linked.id]);
  });

  it('applies min_likes and min_boosts against the stored counters', async () => {
    const popular = await seedPost(scope, { content: body('popular') });
    const quiet = await seedPost(scope, { content: body('quiet') });
    await setCounters(popular.id, { likes: 9, boosts: 4 });
    await setCounters(quiet.id, { likes: 1, boosts: 0 });

    expect(await idsFor({ query: `${TERM} min_likes:5` })).toEqual([popular.id]);
    expect(await idsFor({ query: `${TERM} min_boosts:3` })).toEqual([popular.id]);
    expect((await idsFor({ query: `${TERM} min_likes:0`, limit: 50 })).sort())
      .toEqual([popular.id, quiet.id].sort());
  });

  it('bounds the window with since: and until:', async () => {
    const old = await seedPost(scope, {
      content: body('older'),
      createdAt: new Date('2025-12-25T00:00:00.000Z'),
    });
    const recent = await seedPost(scope, {
      content: body('newer'),
      createdAt: new Date('2026-01-15T00:00:00.000Z'),
    });

    expect(await idsFor({ query: `${TERM} since:2026-01-01` })).toEqual([recent.id]);
    expect(await idsFor({ query: `${TERM} until:2026-01-01` })).toEqual([old.id]);
  });

  it('strips every operator token from the text it searches for', async () => {
    // A leaked token makes the search hunt for the literal `from:me`, which
    // matches nothing — indistinguishable from "no results" to a caller.
    const post = await seedPost(scope, {
      oxyUserId: VIEWER,
      authorship: [{ oxyUserId: VIEWER, role: 'owner', status: 'accepted' }],
      content: body('rust release'),
      hasLinks: true,
    });
    await setCounters(post.id, { likes: 7 });

    const ids = await idsFor({
      query: `${TERM} from:me has:links min_likes:5 since:2026-01-01 rust release`,
    });
    expect(ids).toEqual([post.id]);
  });

  it('accepts a quoted operand without leaking the quotes into the lookup', async () => {
    const author = scope.user('quoted');
    const post = await seedPost(scope, {
      oxyUserId: author,
      authorship: [{ oxyUserId: author, role: 'owner', status: 'accepted' }],
      content: body('news'),
    });
    mocks.getProfileByUsername.mockResolvedValue({ id: author });

    expect(await idsFor({ query: `${TERM} from:"alice" news` })).toEqual([post.id]);
    expect(mocks.getProfileByUsername).toHaveBeenCalledWith('alice');
  });

  it('filters by any of the post\'s detected languages, not only the primary', async () => {
    const bilingual = await seedPost(scope, {
      content: body('bilingual'),
      language: 'en',
      postClassification: { languages: ['en', 'es'] },
    });
    await seedPost(scope, {
      content: body('monolingual'),
      language: 'en',
      postClassification: { languages: ['en'] },
    });

    expect(await idsFor({ query: TERM, language: 'es' })).toEqual([bilingual.id]);
  });
});

describe('GET /search — sensitive-content gating', () => {
  /** Each independent signal that makes a post sensitive, one post apiece. */
  async function seedOneOfEachSensitiveShape(): Promise<string[]> {
    const classified = await seedPost(scope, {
      content: body('classified sensitive'),
      postClassification: { sensitive: true },
    });
    const flagged = await seedPost(scope, {
      content: body('author flagged'),
      metadata: { isSensitive: true },
    });
    const federated = await seedPost(scope, {
      content: body('remote flagged'),
      federation: { activityId: `https://remote.test/${scope.name}/1`, sensitive: true },
    });
    const nsfwTagged = await seedPost(scope, {
      content: body('tagged'),
      hashtags: ['nsfw'],
    });
    return [classified.id, flagged.id, federated.id, nsfwTagged.id];
  }

  it('excludes every sensitive shape for a viewer who has not opted in', async () => {
    const gated = await seedOneOfEachSensitiveShape();
    const safe = await seedPost(scope, { content: body('safe') });

    const ids = await idsFor({ query: TERM, limit: 50 });

    expect(ids).toEqual([safe.id]);
    for (const id of gated) expect(ids).not.toContain(id);
  });

  it('returns them all for a viewer who opted in', async () => {
    const gated = await seedOneOfEachSensitiveShape();
    const safe = await seedPost(scope, { content: body('safe') });
    await optInToSensitive(VIEWER);

    const ids = await idsFor({ query: TERM, limit: 50 });

    expect(ids.sort()).toEqual([...gated, safe.id].sort());
  });

  it('never drops an UNCLASSIFIED post from a safe-mode page', async () => {
    // The `is not true` half of the gate. Two of the three flag columns are
    // nullable, and `<> true` against NULL is NULL — so a literal translation of
    // Mongo's `$ne: true` would silently hide every post that was never
    // classified, which is the overwhelming majority.
    const unclassified = await seedPost(scope, { content: body('never classified') });
    const [row] = await getDb()
      .select({
        classificationSensitive: posts.classificationSensitive,
        federationSensitive: posts.federationSensitive,
        hashtags: posts.hashtags,
      })
      .from(posts)
      .where(eq(posts.id, unclassified.id));

    expect(row.classificationSensitive).toBeNull();
    expect(row.federationSensitive).toBeNull();
    expect(await idsFor({ query: `${TERM} classified` })).toEqual([unclassified.id]);
  });

  it('gates an anonymous viewer, who has no opt-in to consult', async () => {
    const gated = await seedOneOfEachSensitiveShape();
    const safe = await seedPost(scope, { content: body('safe') });

    const ids = await idsFor({ query: TERM, limit: 50 }, anonApp);

    expect(ids).toContain(safe.id);
    for (const id of gated) expect(ids).not.toContain(id);
  });
});

describe('GET /search — muted words', () => {
  it('never returns a post whose body carries a term the viewer muted', async () => {
    const clean = await seedPost(scope, { content: body('a perfectly ordinary post') });
    await seedPost(scope, { content: body('massive spoilers for the finale') });
    await mute(VIEWER, { value: 'spoilers', targets: ['content', 'tag'] });

    const page = await search({ query: TERM, limit: 50 });

    expect(page.posts.map((post) => post.id)).toEqual([clean.id]);
    expect(JSON.stringify(page)).not.toContain('spoilers');
  });

  it('never returns a post carrying a hashtag the viewer muted', async () => {
    await seedPost(scope, { content: body('election night'), hashtags: ['politics'] });
    await mute(VIEWER, { value: 'politics', targets: ['tag'] });

    expect((await search({ query: TERM, limit: 50 })).posts).toEqual([]);
  });

  it('keeps a followed author when the rule excludes follows', async () => {
    const followed = scope.user('followed');
    const clean = await seedPost(scope, { content: body('ordinary') });
    const offending = await seedPost(scope, {
      oxyUserId: followed,
      authorship: [{ oxyUserId: followed, role: 'owner', status: 'accepted' }],
      content: body('spoilers for the finale'),
    });
    await mute(VIEWER, {
      value: 'spoilers',
      targets: ['content'],
      actorTarget: 'exclude-following',
    });
    mocks.getUserFollowing.mockResolvedValue([{ id: followed }]);

    const ids = (await search({ query: TERM, limit: 50 })).posts.map((post) => post.id);

    expect(mocks.getUserFollowing).toHaveBeenCalledWith(VIEWER);
    expect(ids.sort()).toEqual([clean.id, offending.id].sort());
  });

  it('does not pay for the follow-graph lookup when no rule needs it', async () => {
    await seedPost(scope, { content: body('ordinary') });
    await mute(VIEWER, { value: 'spoilers', targets: ['content'], actorTarget: 'all' });

    await search({ query: TERM, limit: 50 });

    expect(mocks.getUserFollowing).not.toHaveBeenCalled();
  });

  it('takes the cursor from the UNFILTERED page window, so a drop skips nothing', async () => {
    // Three matches, page size two. The second is muted, so the page returns one
    // post — but the cursor must still be the second post, or the third is
    // skipped forever on the next page.
    const first = await seedPost(scope, {
      content: body('ordinary one'),
      createdAt: new Date('2026-03-03T00:00:00.000Z'),
    });
    await seedPost(scope, {
      content: body('spoilers here'),
      createdAt: new Date('2026-03-02T00:00:00.000Z'),
    });
    const third = await seedPost(scope, {
      content: body('ordinary three'),
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    await mute(VIEWER, { value: 'spoilers', targets: ['content'] });

    const page = await search({ query: `${TERM} ordinary OR spoilers`, limit: 2 });
    expect(page.posts.map((post) => post.id)).toEqual([first.id]);
    expect(page.hasMore).toBe(true);

    const next = await search({
      query: `${TERM} ordinary OR spoilers`,
      limit: 2,
      cursor: page.nextCursor as string,
    });
    expect(next.posts.map((post) => post.id)).toEqual([third.id]);
  });
});
