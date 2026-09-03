import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassificationTopicRef, PostType as PostTypeValue } from '@mention/shared-types';

/**
 * Coverage for the Stage-B AI post-classification batch service.
 *
 * The Oxy inference edge and the Topic registry are mocked — no network — but the
 * QUEUE is real. We drive `processQueue()` against rows in Postgres with canned
 * edge responses across every category the issue requires (positive, neutral,
 * mixed/constructive, toxic, spammy, low-quality) plus the failure/retry path,
 * and assert on the `postClassification` each post is left holding.
 *
 * Two invariants are checked throughout:
 *  - classification is independent of hashtags (none are read or written);
 *  - no provider/model string is ever written onto the post.
 *
 * ## What changed with the Postgres port, and why it is the whole point here
 *
 * The old suite mocked `Post.find` to return canned documents and then asserted
 * on the DOTTED `$set` objects handed to `bulkWrite`. Two of its checks were
 * assertions about a query object — `{ 'content.variants.0': { $exists: true } }`
 * for the batch selector and its negation for `markEmptyPosts` — written
 * explicitly because a filter keyed on the retired `content.text` would compile,
 * run, and match ZERO documents, stopping Stage-B network-wide in silence.
 *
 * That risk did not go away with the port; it got WORSE and changed shape. The
 * selector is now a correlated `EXISTS` subquery against `post_content_variants`
 * (`hasVariantSql`), and at drizzle 0.45.2 a column interpolated into a raw
 * `sql` template can render BARE in a single-table select — so the subquery
 * compares two of the INNER table's own columns, matches nothing, raises no
 * error, and the queue silently stops. An assertion on the built query cannot
 * tell that apart from a correct one. So every selector claim below is made by
 * seeding a row that must be picked and a row that must not, and asserting the
 * EXACT non-zero outcome on both.
 *
 * ## Owning the queue in a parallel run
 *
 * `classifyBatch` selects the oldest 25 unclassified published non-boost posts
 * IN THE WHOLE TABLE — it has no notion of a test scope, and vitest runs ten
 * files at once against one database. So each test seeds its subjects with an
 * ancient `createdAt` and pads the rest of the batch with its OWN filler posts,
 * and `expectBatchWasOurs` asserts that every entry the edge was handed belongs to
 * this suite. Without that guard a passing run could have been classifying
 * another file's rows out from under it.
 */

const { inferenceJSON, isInferenceEnabled, resolveTopicRefs } = vi.hoisted(() => ({
  inferenceJSON: vi.fn(),
  isInferenceEnabled: vi.fn().mockReturnValue(true),
  resolveTopicRefs: vi.fn(),
}));

// Force classification ON for this suite (gated OFF by default). Everything
// else — the Postgres connection settings above all — comes from the REAL
// config: an object literal here would have to restate `config.postgres` and
// would then be the thing under test.
vi.mock('../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config')>();
  return {
    ...actual,
    config: { ...actual.config, classification: { ...actual.config.classification, enabled: true } },
  };
});

vi.mock('../../utils/oxyInference', () => ({
  inferenceJSON: (...args: unknown[]) => inferenceJSON(...args),
  isInferenceEnabled: () => isInferenceEnabled(),
}));

// Mock ONLY the Topic registry resolution (an Oxy round trip). By default each
// slug resolves to a deterministic `topicId` so the canonical `topicRefs` carry
// registry linkage; individual tests override it to assert the fallbacks.
vi.mock('../../services/TopicService', () => ({
  topicService: {
    resolveTopicRefs: (topics: Array<{ name: string }>) => resolveTopicRefs(topics),
  },
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { insertPostRecord, updatePostRecord } from '../../db/posts/postRepository';
import { PostType, PostVisibility } from '@mention/shared-types';
import { postClassificationService } from '../../services/PostClassificationService';
import type { PostRecord, PostRecordClassification } from '../../db/posts/postRecord';

const scope = serviceScope('post-classification');
const AUTHOR = scope.user('author');

/**
 * `PostClassificationService.BATCH_SIZE`. Restated because it is private and
 * because owning the batch is what keeps this suite isolated — if it changes,
 * `expectBatchWasOurs` fails loudly rather than the suite quietly starting to
 * classify other files' posts.
 */
const BATCH_SIZE = 25;

/** Long before any other suite's rows, so ours sort to the head of the queue. */
const ANCIENT = Date.parse('2001-01-01T00:00:00.000Z');

/** Every body this suite writes starts with this, which is how ownership is proven. */
const OWNED_PREFIX = `${scope.name}:`;

interface AiResult {
  postIndex: number;
  topics: string[];
  sentiment: string;
  intent: string;
  scores: Record<string, number>;
  confidence: number;
}

/** A neutral, schema-valid inference result — what a filler post gets. */
function neutralResult(postIndex: number): AiResult {
  return {
    postIndex,
    topics: [],
    sentiment: 'neutral',
    intent: 'other',
    scores: { toxicity: 0, constructiveness: 0, spam: 0, quality: 0.5, controversy: 0, negativity: 0 },
    confidence: 0.5,
  };
}

let seedClock = 0;

/**
 * Seed one classifiable subject: published, public, non-boost, one rendition,
 * `classification_status` left at the column default of `pending`.
 *
 * Returned in seeding order, and each gets a `createdAt` one second after the
 * last, so subject N is at `postIndex` N in the inference payload.
 */
async function seedSubject(text: string, overrides: {
  hashtags?: string[];
  classification?: Partial<PostRecordClassification>;
  type?: PostTypeValue;
} = {}): Promise<PostRecord> {
  seedClock += 1;
  return seedPost(scope, {
    oxyUserId: AUTHOR,
    type: overrides.type ?? PostType.TEXT,
    hashtags: overrides.hashtags,
    content: { variants: [{ source: 'author', text: `${OWNED_PREFIX}${text}`, tag: 'en' }] },
    createdAt: new Date(ANCIENT + seedClock * 1000),
    ...(overrides.classification ? { postClassification: overrides.classification } : {}),
  });
}

/**
 * Pad the batch to {@link BATCH_SIZE} with this suite's own posts.
 *
 * Untracked on purpose: they carry the scope's owner prefix, so
 * `clearServiceScope`'s single sweep removes them without 24 individual deletes.
 */
async function padBatch(subjectCount: number): Promise<void> {
  const fillers = BATCH_SIZE - subjectCount;
  if (fillers <= 0) return;
  await Promise.all(
    Array.from({ length: fillers }, (_unused, index) =>
      insertPostRecord({
        oxyUserId: AUTHOR,
        authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
        type: PostType.TEXT,
        visibility: PostVisibility.PUBLIC,
        status: 'published',
        content: {
          variants: [{ source: 'author', text: `${OWNED_PREFIX}filler ${index}`, tag: 'en' }],
        },
        // After every subject, before every other file's rows.
        createdAt: new Date(ANCIENT + (100 + index) * 1000),
      }),
    ),
  );
}

/** The batch the edge was handed, as the service serialized it. */
function inferencePayload(): Array<{ postIndex: number; text: string }> {
  const [messages] = inferenceJSON.mock.calls[0] as [Array<{ role: string; content: string }>];
  const user = messages.find((message) => message.role === 'user');
  if (!user) throw new Error('no user message was sent to the inference edge');
  return JSON.parse(user.content);
}

/**
 * Assert the batch contained ONLY this suite's posts.
 *
 * The vacuity floor for every test below: the queue is global, so a batch that
 * silently picked up another file's rows would make the classification
 * assertions meaningless AND would corrupt that file mid-run.
 */
function expectBatchWasOurs(): void {
  const payload = inferencePayload();
  expect(payload).toHaveLength(BATCH_SIZE);
  for (const entry of payload) {
    expect(entry.text.startsWith(OWNED_PREFIX)).toBe(true);
  }
}

/**
 * Answer the inference edge with the canned results for the SUBJECTS and a neutral verdict for
 * every filler, so nothing in the batch is left to retry.
 */
function respondWith(subjectResults: AiResult[]): void {
  inferenceJSON.mockImplementation(async (messages: Array<{ role: string; content: string }>) => {
    const user = messages.find((message) => message.role === 'user');
    const payload = JSON.parse(user?.content ?? '[]') as Array<{ postIndex: number }>;
    const canned = new Map(subjectResults.map((result) => [result.postIndex, result]));
    return payload.map((entry) => canned.get(entry.postIndex) ?? neutralResult(entry.postIndex));
  });
}

/** The classification a post is left holding. */
async function classificationOf(postId: string): Promise<PostRecordClassification> {
  const post = await readPost(postId);
  if (!post) throw new Error(`post ${postId} is gone`);
  return post.postClassification;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearServiceScope(scope);
  seedClock = 0;
  isInferenceEnabled.mockReturnValue(true);
  resolveTopicRefs.mockImplementation(
    async (topics: Array<{ name: string }>): Promise<ClassificationTopicRef[]> =>
      topics.map((topic) => ({ name: topic.name, topicId: `topic:${topic.name}` })),
  );
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('PostClassificationService — category classification', () => {
  it('classifies positive product feedback', async () => {
    const post = await seedSubject('I love how much faster the Mention feed feels now.');
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: ['mention', 'product_feedback', 'feed'],
        sentiment: 'positive',
        intent: 'feedback',
        scores: { toxicity: 0, constructiveness: 0.8, spam: 0, quality: 0.75, controversy: 0, negativity: 0 },
        confidence: 0.9,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    const classification = await classificationOf(post.id);
    expect(classification.status).toBe('classified');
    expect(classification.sentiment).toBe('positive');
    expect(classification.intent).toBe('feedback');
    expect(classification.topics).toEqual(['mention', 'product_feedback', 'feed']);
    expect(classification.classifiedAt).toBeInstanceOf(Date);
    expect(classification.confidence).toBe(0.9);
    expect(classification.scores.toxicity).toBe(0);
    expect(classification.scores.constructiveness).toBe(0.8);
  });

  it('classifies neutral posts', async () => {
    const post = await seedSubject('Heading to the office, see you all later.');
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: ['personal_update'],
        sentiment: 'neutral',
        intent: 'personal_update',
        scores: { toxicity: 0, constructiveness: 0.2, spam: 0, quality: 0.4, controversy: 0, negativity: 0 },
        confidence: 0.7,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    const classification = await classificationOf(post.id);
    expect(classification.sentiment).toBe('neutral');
    expect(classification.intent).toBe('personal_update');
    expect(classification.status).toBe('classified');
  });

  it('classifies constructive mixed criticism with high constructiveness and low toxicity', async () => {
    const post = await seedSubject('The new feed still breaks when refreshing, but the direction is good.');
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: ['mention', 'product_feedback', 'bugs', 'feed'],
        sentiment: 'mixed',
        intent: 'feedback',
        scores: { toxicity: 0, constructiveness: 0.85, spam: 0, quality: 0.8, controversy: 0.1, negativity: 0.45 },
        confidence: 0.88,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    const { sentiment, scores } = await classificationOf(post.id);
    expect(sentiment).toBe('mixed');
    // Constructive criticism: negative but not toxic, and highly constructive.
    expect(scores.toxicity).toBe(0);
    expect(scores.constructiveness).toBe(0.85);
    expect(scores.negativity).toBe(0.45);
  });

  it('classifies toxic complaints with high toxicity and low constructiveness', async () => {
    const post = await seedSubject('This is trash and everyone here is stupid.');
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: ['general_complaint'],
        sentiment: 'negative',
        intent: 'complaint',
        scores: { toxicity: 0.85, constructiveness: 0.05, spam: 0, quality: 0.15, controversy: 0.5, negativity: 0.95 },
        confidence: 0.9,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    const { sentiment, scores } = await classificationOf(post.id);
    expect(sentiment).toBe('negative');
    expect(scores.toxicity).toBe(0.85);
    expect(scores.constructiveness).toBe(0.05);
  });

  it('classifies spammy posts with high spam score', async () => {
    const post = await seedSubject('FREE CRYPTO!!! Click here to claim 1000x returns now!!!');
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: ['promotion'],
        sentiment: 'positive',
        intent: 'announcement',
        scores: { toxicity: 0.1, constructiveness: 0, spam: 0.95, quality: 0.05, controversy: 0.2, negativity: 0.1 },
        confidence: 0.92,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    const { scores } = await classificationOf(post.id);
    expect(scores.spam).toBe(0.95);
    expect(scores.quality).toBe(0.05);
  });

  it('classifies low-quality posts with low quality score', async () => {
    const post = await seedSubject('k');
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: [],
        sentiment: 'neutral',
        intent: 'other',
        scores: { toxicity: 0, constructiveness: 0, spam: 0, quality: 0.05, controversy: 0, negativity: 0 },
        confidence: 0.6,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    const classification = await classificationOf(post.id);
    expect(classification.scores.quality).toBe(0.05);
    // An empty AI topic list must CLEAR the column rather than leave whatever the
    // Stage-A baseline put there — `topics` is the one field both stages own.
    expect(classification.topics ?? []).toEqual([]);
  });

  it('classifies a mixed batch of multiple posts by postIndex, not by arrival order', async () => {
    const first = await seedSubject('Great release today!');
    const second = await seedSubject('This app is garbage.');
    await padBatch(2);
    // Deliberately out of order in the response: the mapping is by `postIndex`.
    respondWith([
      {
        postIndex: 1,
        topics: ['complaint'],
        sentiment: 'negative',
        intent: 'complaint',
        scores: { toxicity: 0.4, constructiveness: 0.1, spam: 0, quality: 0.2, controversy: 0.3, negativity: 0.8 },
        confidence: 0.8,
      },
      {
        postIndex: 0,
        topics: ['announcement'],
        sentiment: 'positive',
        intent: 'announcement',
        scores: { toxicity: 0, constructiveness: 0.5, spam: 0, quality: 0.7, controversy: 0, negativity: 0 },
        confidence: 0.85,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    expect((await classificationOf(first.id)).sentiment).toBe('positive');
    expect((await classificationOf(second.id)).sentiment).toBe('negative');
  });
});

describe('PostClassificationService — provider/model isolation', () => {
  it('never writes a provider/model string onto the post', async () => {
    const post = await seedSubject('A normal post about coffee.');
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: ['coffee'],
        sentiment: 'positive',
        intent: 'opinion',
        scores: { toxicity: 0, constructiveness: 0.3, spam: 0, quality: 0.5, controversy: 0, negativity: 0 },
        confidence: 0.8,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    const serialized = JSON.stringify(await classificationOf(post.id)).toLowerCase();
    for (const banned of ['gemini', 'openai', 'anthropic', 'gpt', 'claude', 'model', 'provider']) {
      expect(serialized).not.toContain(banned);
    }
  });

  it('does not read or write hashtags (classification is independent of hashtags)', async () => {
    const post = await seedSubject('Loving the new design #mention #ui #ux', {
      hashtags: ['mention', 'ui', 'ux'],
    });
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: ['design', 'product_feedback'],
        sentiment: 'positive',
        intent: 'feedback',
        scores: { toxicity: 0, constructiveness: 0.6, spam: 0, quality: 0.7, controversy: 0, negativity: 0 },
        confidence: 0.85,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    // The author's hashtags are untouched by Stage B, and the AI's inferred
    // topics are what landed — not the tags. `hashtags` is its own column, so a
    // patch that reached it would be visible right here.
    const stored = await readPost(post.id);
    expect(stored?.hashtags).toEqual(['mention', 'ui', 'ux']);
    expect(stored?.postClassification.topics).toEqual(['design', 'product_feedback']);
    // Nor did Stage B touch the Stage-A normalization of those tags.
    expect(stored?.postClassification.hashtagsNorm).toBeUndefined();
  });
});

describe('PostClassificationService — Stage-A baseline preservation', () => {
  it('preserves the Stage-A deterministic fields through AI enrichment', async () => {
    // The AI stage patches only the fields it owns. Against Mongo this was a
    // DOTTED `$set`; here it is a key-by-key merge in `updatePostRecord`. Either
    // way, writing the whole subdocument would wipe Stage A — and the only
    // assertion that can tell the difference is on the row afterwards.
    const post = await seedSubject('I love how much faster the Mention feed feels now.', {
      classification: {
        status: 'pending',
        languages: ['en', 'es'],
        region: 'ES',
        hashtagsNorm: ['feed'],
        version: 7,
        sensitive: true,
      },
    });
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: ['mention', 'feed', 'product_feedback'],
        sentiment: 'positive',
        intent: 'feedback',
        scores: { toxicity: 0, constructiveness: 0.8, spam: 0, quality: 0.75, controversy: 0, negativity: 0 },
        confidence: 0.9,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    const classification = await classificationOf(post.id);
    // Stage A survived, field for field.
    expect(classification.languages).toEqual(['en', 'es']);
    expect(classification.region).toBe('ES');
    expect(classification.hashtagsNorm).toEqual(['feed']);
    expect(classification.version).toBe(7);
    expect(classification.sensitive).toBe(true);
    // Stage B was applied on top.
    expect(classification.status).toBe('classified');
    expect(classification.sentiment).toBe('positive');
    expect(classification.topics).toEqual(['mention', 'feed', 'product_feedback']);
  });
});

describe('PostClassificationService — canonical topicRefs resolution', () => {
  it('resolves AI-refined topics into registry-linked topicRefs, in order', async () => {
    const post = await seedSubject('A post about basketball and the lakers.');
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: ['basketball', 'lakers'],
        sentiment: 'positive',
        intent: 'opinion',
        scores: { toxicity: 0, constructiveness: 0.4, spam: 0, quality: 0.6, controversy: 0, negativity: 0 },
        confidence: 0.8,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    // The registry resolver was called ONCE for the whole batch with the unique
    // slugs — the fillers contribute none.
    expect(resolveTopicRefs).toHaveBeenCalledTimes(1);
    expect(resolveTopicRefs.mock.calls[0][0]).toEqual([{ name: 'basketball' }, { name: 'lakers' }]);

    // Both encodings are persisted: `topics` is a scalar array column,
    // `topicRefs` a CHILD TABLE that `updatePostRecord` has to replace by hand.
    // That second write is the one worth pinning — the patch type accepts
    // `topicRefs` whether or not the implementation maps it, so a repository
    // that ignored the key would drop every registry-linked ref that Stage B
    // produces, silently, while `topics` kept looking right.
    const classification = await classificationOf(post.id);
    expect(classification.topics).toEqual(['basketball', 'lakers']);
    expect(classification.topicRefs).toEqual([
      { name: 'basketball', topicId: 'topic:basketball' },
      { name: 'lakers', topicId: 'topic:lakers' },
    ]);
  });

  it('falls back to name-only topicRefs when the registry resolves no id', async () => {
    const post = await seedSubject('A post about an obscure niche topic.');
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: ['obscure_topic'],
        sentiment: 'neutral',
        intent: 'other',
        scores: { toxicity: 0, constructiveness: 0.2, spam: 0, quality: 0.3, controversy: 0, negativity: 0 },
        confidence: 0.5,
      },
    ]);
    // Registry returns the name without a topicId (unresolved slug).
    resolveTopicRefs.mockResolvedValueOnce([{ name: 'obscure_topic' }]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    expect(resolveTopicRefs).toHaveBeenCalledTimes(1);
    // The ref is stored by NAME with no `topic_id` — an unresolved slug is still
    // a canonical topic; readers that need a `topicId` simply skip it.
    const classification = await classificationOf(post.id);
    expect(classification.status).toBe('classified');
    expect(classification.topicRefs).toEqual([{ name: 'obscure_topic' }]);
  });

  it('stores name-only topicRefs when registry resolution throws (never drops the canonical list)', async () => {
    const post = await seedSubject('A post about coffee and espresso.');
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: ['coffee', 'espresso'],
        sentiment: 'positive',
        intent: 'opinion',
        scores: { toxicity: 0, constructiveness: 0.3, spam: 0, quality: 0.5, controversy: 0, negativity: 0 },
        confidence: 0.7,
      },
    ]);
    resolveTopicRefs.mockRejectedValueOnce(new Error('registry unreachable'));

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    // The post is still classified and BOTH encodings survive — a registry
    // outage costs the `topicId` linkage, never the canonical topic list.
    const classification = await classificationOf(post.id);
    expect(classification.status).toBe('classified');
    expect(classification.topics).toEqual(['coffee', 'espresso']);
    expect(classification.topicRefs).toEqual([{ name: 'coffee' }, { name: 'espresso' }]);
  });

  it('CLEARS the existing topicRefs when enrichment returns no topics', async () => {
    // The replace is wholesale, not a merge: a topic the classifier dropped has
    // to disappear. Seeded WITH refs so "none afterwards" is a clearance rather
    // than a post that never had any — the difference the previous case cannot
    // make on its own.
    const post = await seedSubject('used to be about chess', {
      classification: {
        status: 'pending',
        topicRefs: [{ name: 'chess', topicId: 'topic:chess' }],
      },
    });
    expect((await classificationOf(post.id)).topicRefs).toEqual([
      { name: 'chess', topicId: 'topic:chess' },
    ]);
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: [],
        sentiment: 'neutral',
        intent: 'other',
        scores: { toxicity: 0, constructiveness: 0, spam: 0, quality: 0.3, controversy: 0, negativity: 0 },
        confidence: 0.4,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    // An empty list clears the rows; the reload reports `undefined`, not `[]`.
    expect((await classificationOf(post.id)).topicRefs).toBeUndefined();
    expect((await classificationOf(post.id)).status).toBe('classified');
  });

  it('REPLACES rather than appends, so a dropped topic is gone', async () => {
    const post = await seedSubject('a post whose topics change', {
      classification: {
        status: 'pending',
        topicRefs: [
          { name: 'chess', topicId: 'topic:chess' },
          { name: 'sailing', topicId: 'topic:sailing' },
        ],
      },
    });
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: ['sailing'],
        sentiment: 'neutral',
        intent: 'other',
        scores: { toxicity: 0, constructiveness: 0, spam: 0, quality: 0.4, controversy: 0, negativity: 0 },
        confidence: 0.6,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    // `chess` is gone, not merged. The `(post_id, name)` unique index would have
    // rejected a plain re-insert of `sailing`, so an append-only implementation
    // fails loudly here rather than silently doubling.
    expect((await classificationOf(post.id)).topicRefs).toEqual([
      { name: 'sailing', topicId: 'topic:sailing' },
    ]);
  });

  it('stores no topicRefs row when the AI returns no topics', async () => {
    const post = await seedSubject('gm everyone');
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: [],
        sentiment: 'neutral',
        intent: 'personal_update',
        scores: { toxicity: 0, constructiveness: 0.1, spam: 0, quality: 0.2, controversy: 0, negativity: 0 },
        confidence: 0.4,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    // No topics anywhere in the batch → the resolver is never called at all.
    expect(resolveTopicRefs).not.toHaveBeenCalled();
    expect((await classificationOf(post.id)).topicRefs).toBeUndefined();
  });
});

/**
 * The two `topicRefs` properties the enrichment path depends on but cannot
 * itself demonstrate.
 *
 * `classifyBatch` always sends `status`, `attempts` and `classifiedAt` alongside
 * the refs, so it can never produce a patch whose scalar set is EMPTY — and the
 * AI never supplies a `relevance`, so it can never produce two refs that sort
 * differently from alphabetical. Both are reachable from a direct
 * `updatePostRecord` / seed, and both are load-bearing for this suite: the first
 * is what makes the child write survive the "nothing to update" early return,
 * the second is the read order every assertion above is written against.
 */
describe('PostClassificationService — the topicRefs write and read order it relies on', () => {
  it('writes topicRefs from a patch that carries NO scalar values', async () => {
    // `updatePostRecord` returns early when the scalar set is empty. The child
    // write has to happen BEFORE that return, or a patch carrying only
    // `topicRefs` silently does nothing.
    const post = await seedSubject('a post whose scalars are already correct');

    await updatePostRecord(post.id, {
      postClassification: { topicRefs: [{ name: 'kayaking', topicId: 'topic:kayaking' }] },
    });

    expect((await classificationOf(post.id)).topicRefs).toEqual([
      { name: 'kayaking', topicId: 'topic:kayaking' },
    ]);
  });

  it('leaves existing topicRefs untouched when the patch omits them', async () => {
    // A status-only update must not wipe the classifier's work — `undefined`
    // means "not stated", which is a different thing from `[]`.
    const post = await seedSubject('a post with settled topics', {
      classification: {
        status: 'classified',
        topicRefs: [{ name: 'kayaking', topicId: 'topic:kayaking' }],
      },
    });

    await updatePostRecord(post.id, { postClassification: { attempts: 2 } });

    const classification = await classificationOf(post.id);
    expect(classification.attempts).toBe(2);
    expect(classification.topicRefs).toEqual([{ name: 'kayaking', topicId: 'topic:kayaking' }]);
  });

  it('reads topicRefs back by RELEVANCE, with the name only as a tie-break', async () => {
    // The table has no `position` column, so insertion order is unrecoverable
    // and the read-back sorts `relevance DESC NULLS LAST, name ASC`. Chosen so
    // the two candidate sorts DISAGREE: alphabetically this is
    // `alpha, mid, zulu`, and by relevance it is `zulu, mid, alpha`. Every
    // assertion elsewhere in this file happens to use relevance-free refs whose
    // alphabetical order is also the stored one, so without this case the sort
    // could be either and nothing would notice.
    const post = await seedSubject('a post the classifier ranked', {
      classification: {
        status: 'classified',
        topicRefs: [
          { name: 'alpha', topicId: 'topic:alpha', relevance: 2 },
          { name: 'zulu', topicId: 'topic:zulu', relevance: 9 },
          { name: 'mid', topicId: 'topic:mid', relevance: 5 },
        ],
      },
    });

    expect((await classificationOf(post.id)).topicRefs?.map((ref) => ref.name)).toEqual([
      'zulu',
      'mid',
      'alpha',
    ]);
  });

  it('sorts a ref with NO relevance last, whatever its name', async () => {
    // `NULLS LAST` is the half a plain `relevance DESC` gets wrong: postgres
    // sorts NULLs FIRST on a descending sort by default, which would put the
    // unranked topic at the head of the list.
    const post = await seedSubject('a post with one ranked and one unranked topic', {
      classification: {
        status: 'classified',
        topicRefs: [
          // Alphabetically first AND unranked, so it leads under either mistake.
          { name: 'aaa-unranked', topicId: 'topic:aaa' },
          { name: 'zzz-ranked', topicId: 'topic:zzz', relevance: 4 },
        ],
      },
    });

    expect((await classificationOf(post.id)).topicRefs?.map((ref) => ref.name)).toEqual([
      'zzz-ranked',
      'aaa-unranked',
    ]);
  });

  it('refuses a relevance outside the 1..10 scale rather than truncating it', async () => {
    // `relevance` is a 1..10 integer, NOT a percentage — a caller handing it a
    // 0..100 confidence must fail loudly at the CHECK instead of storing a
    // number every reader would misinterpret.
    //
    // The CHECK name is asserted off `cause`, not off the message: drizzle wraps
    // the driver error in a `Failed query: …` string that names the table but
    // not the constraint, so matching the message would pass for a NOT NULL or a
    // foreign-key violation just as happily.
    const rejection = await seedSubject('a post scored on the wrong scale', {
      classification: {
        status: 'classified',
        topicRefs: [{ name: 'overscored', topicId: 'topic:overscored', relevance: 90 }],
      },
    }).then(
      () => null,
      (error: { cause?: { constraint_name?: string } }) => error,
    );

    expect(rejection).not.toBeNull();
    expect(rejection?.cause?.constraint_name).toBe(
      'post_classification_topic_refs_relevance_check',
    );
  });
});

describe('PostClassificationService — failure and retry behavior', () => {
  it('leaves posts pending (retry) on AI network failure under the retry budget', async () => {
    const post = await seedSubject('A post that will fail to classify.');
    await padBatch(1);
    inferenceJSON.mockRejectedValue(new Error('network down'));

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    const classification = await classificationOf(post.id);
    expect(classification.status).toBe('pending');
    expect(classification.attempts).toBe(1);
    // Still retryable, so nothing may claim it was decided.
    expect(classification.classifiedAt).toBeUndefined();
  });

  it('flips to failed once the retry budget is exhausted', async () => {
    // attempts already at 2 → next attempt (3) hits MAX_ATTEMPTS and expires.
    const post = await seedSubject('A persistently failing post.', {
      classification: { status: 'pending', attempts: 2 },
    });
    await padBatch(1);
    inferenceJSON.mockRejectedValue(new Error('still down'));

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    const classification = await classificationOf(post.id);
    expect(classification.status).toBe('failed');
    expect(classification.attempts).toBe(3);
    expect(classification.classifiedAt).toBeInstanceOf(Date);
  });

  it('marks posts for retry when the AI response fails schema validation', async () => {
    const post = await seedSubject('Schema-busting response incoming.');
    await padBatch(1);
    // Score out of range → zod validation fails → the WHOLE batch is retried.
    inferenceJSON.mockResolvedValue([
      {
        postIndex: 0,
        topics: ['x'],
        sentiment: 'positive',
        intent: 'opinion',
        scores: { toxicity: 5, constructiveness: 0, spam: 0, quality: 0, controversy: 0, negativity: 0 },
        confidence: 0.5,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    const classification = await classificationOf(post.id);
    expect(classification.status).toBe('pending');
    expect(classification.attempts).toBe(1);
  });

  it('counts an attempt for a post missing from the AI response', async () => {
    const present = await seedSubject('This one got classified.');
    const missing = await seedSubject('This one was dropped by the model.');
    await padBatch(2);
    // A result for index 0 and every filler, but nothing for index 1.
    respondWith([
      {
        postIndex: 0,
        topics: ['ok'],
        sentiment: 'neutral',
        intent: 'other',
        scores: { toxicity: 0, constructiveness: 0, spam: 0, quality: 0.5, controversy: 0, negativity: 0 },
        confidence: 0.7,
      },
    ]);
    inferenceJSON.mockImplementation(async (messages: Array<{ role: string; content: string }>) => {
      const user = messages.find((message) => message.role === 'user');
      const payload = JSON.parse(user?.content ?? '[]') as Array<{ postIndex: number }>;
      return payload
        .filter((entry) => entry.postIndex !== 1)
        .map((entry) =>
          entry.postIndex === 0
            ? {
              postIndex: 0,
              topics: ['ok'],
              sentiment: 'neutral',
              intent: 'other',
              scores: { toxicity: 0, constructiveness: 0, spam: 0, quality: 0.5, controversy: 0, negativity: 0 },
              confidence: 0.7,
            }
            : neutralResult(entry.postIndex),
        );
    });

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    expect((await classificationOf(present.id)).status).toBe('classified');
    const dropped = await classificationOf(missing.id);
    expect(dropped.status).toBe('pending');
    expect(dropped.attempts).toBe(1);
  });

  it('no-ops when inference is unavailable, leaving the queue exactly as it was', async () => {
    const post = await seedSubject('Should not be processed when inference is off.');
    await padBatch(1);
    isInferenceEnabled.mockReturnValue(false);

    await postClassificationService.processQueue();

    expect(inferenceJSON).not.toHaveBeenCalled();
    const classification = await classificationOf(post.id);
    expect(classification.status).toBe('pending');
    expect(classification.attempts).toBe(0);
  });
});

/**
 * THE BATCH SELECTOR — the silent failure this suite exists to prevent.
 *
 * The body lives in `post_content_variants`, so the selector is a correlated
 * `EXISTS` subquery. Nothing about that is type-checked at the value level: a
 * subquery whose correlation is lost matches every row or none, runs without
 * error, and Stage-B classification simply stops network-wide — no exception,
 * no failing request, nothing to page anyone. "Selected nothing" and "nothing to
 * select" are indistinguishable unless the test seeds something that MUST be
 * selected next to something that MUST NOT.
 */
describe('PostClassificationService — the batch selector reads the body’s REAL home', () => {
  it('selects a post that HAS a rendition and skips one that does not', async () => {
    const withBody = await seedSubject('A perfectly ordinary sentence to classify.');
    // No rendition at all: a boost is exactly this shape.
    seedClock += 1;
    const withoutBody = await seedPost(scope, {
      oxyUserId: AUTHOR,
      content: {},
      createdAt: new Date(ANCIENT + seedClock * 1000),
    });
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: ['general'],
        sentiment: 'neutral',
        intent: 'personal_update',
        scores: { toxicity: 0, constructiveness: 0.2, spam: 0, quality: 0.4, controversy: 0, negativity: 0 },
        confidence: 0.7,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    // The body-carrying post was classified BY THE AI…
    const classified = await classificationOf(withBody.id);
    expect(classified.status).toBe('classified');
    expect(classified.sentiment).toBe('neutral');
    expect(classified.topics).toEqual(['general']);
    // …and the body-less one never reached inference: `markEmptyPosts` retired it
    // with the neutral column defaults, so it is `classified` with NO sentiment
    // the model chose and no topics. The two are distinguishable, which is the
    // whole point.
    const retired = await classificationOf(withoutBody.id);
    expect(retired.status).toBe('classified');
    expect(retired.topics).toBeUndefined();
    expect(retired.confidence).toBe(0);
    expect(inferencePayload().some((entry) => entry.text.includes('ordinary sentence'))).toBe(true);
  });

  it('sends the PRIMARY rendition’s body to the classifier, never a machine translation', async () => {
    // Classifying a machine translation would feed the classifier our own output;
    // a second author language would say the same thing twice.
    seedClock += 1;
    const post = await seedPost(scope, {
      oxyUserId: AUTHOR,
      content: {
        variants: [
          { source: 'author', tag: 'es', text: `${OWNED_PREFIX}el cuerpo primario que hay que clasificar` },
          { source: 'machine', tag: 'en', text: `${OWNED_PREFIX}the machine translation that must NOT be classified` },
        ],
      },
      createdAt: new Date(ANCIENT + seedClock * 1000),
    });
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: ['general'],
        sentiment: 'neutral',
        intent: 'personal_update',
        scores: { toxicity: 0, constructiveness: 0.2, spam: 0, quality: 0.4, controversy: 0, negativity: 0 },
        confidence: 0.7,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    const sent = JSON.stringify(inferencePayload());
    expect(sent).toContain('el cuerpo primario que hay que clasificar');
    expect(sent).not.toContain('must NOT be classified');
    expect((await classificationOf(post.id)).status).toBe('classified');
  });

  it('never queues a BOOST, even though a boost can carry a rendition', async () => {
    // A boost has nothing of its own to classify. `boost_of IS NULL` is the
    // discriminator, and `<> NULL` — the literal translation of Mongo's
    // `$ne: null` — is NULL for every row, which would empty the queue entirely.
    const original = await seedSubject('the original everyone is boosting');
    seedClock += 1;
    const boost = await seedPost(scope, {
      oxyUserId: scope.user('booster'),
      type: PostType.BOOST,
      boostOf: original.id,
      content: { variants: [{ source: 'author', text: `${OWNED_PREFIX}boost body`, tag: 'en' }] },
      createdAt: new Date(ANCIENT + seedClock * 1000),
    });
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: ['general'],
        sentiment: 'neutral',
        intent: 'personal_update',
        scores: { toxicity: 0, constructiveness: 0.2, spam: 0, quality: 0.4, controversy: 0, negativity: 0 },
        confidence: 0.7,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    // Listed rather than `.some(...) === false`, so a failure prints the body
    // that reached the classifier instead of `expected true to be false`.
    expect(
      inferencePayload().map((entry) => entry.text).filter((text) => text.includes('boost body')),
    ).toEqual([]);
    // The original WAS classified — proving the queue ran at all, so "the boost
    // was skipped" cannot be satisfied by an empty batch.
    expect((await classificationOf(original.id)).status).toBe('classified');
    expect((await classificationOf(boost.id)).status).toBe('pending');
  });

  it('never queues an unpublished post', async () => {
    const published = await seedSubject('a published post');
    seedClock += 1;
    const draft = await seedPost(scope, {
      oxyUserId: AUTHOR,
      status: 'draft',
      content: { variants: [{ source: 'author', text: `${OWNED_PREFIX}a draft body`, tag: 'en' }] },
      createdAt: new Date(ANCIENT + seedClock * 1000),
    });
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: ['general'],
        sentiment: 'neutral',
        intent: 'personal_update',
        scores: { toxicity: 0, constructiveness: 0.2, spam: 0, quality: 0.4, controversy: 0, negativity: 0 },
        confidence: 0.7,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    expect(
      inferencePayload().map((entry) => entry.text).filter((text) => text.includes('a draft body')),
    ).toEqual([]);
    expect((await classificationOf(published.id)).status).toBe('classified');
    expect((await classificationOf(draft.id)).status).toBe('pending');
  });

  it('never re-queues a post that is already classified', async () => {
    const done = await seedSubject('already handled', {
      classification: { status: 'classified', sentiment: 'positive', topics: ['kept'] },
    });
    const pending = await seedSubject('still waiting');
    // One subject, not two: the classified one is not queueable, so padding for
    // two would leave the batch one short of `BATCH_SIZE` and another file's row
    // could take the slot.
    await padBatch(1);
    respondWith([
      {
        postIndex: 0,
        topics: ['fresh'],
        sentiment: 'negative',
        intent: 'complaint',
        scores: { toxicity: 0, constructiveness: 0, spam: 0, quality: 0.3, controversy: 0, negativity: 0.6 },
        confidence: 0.6,
      },
    ]);

    await postClassificationService.processQueue();
    expectBatchWasOurs();

    // The already-classified post keeps its verdict untouched…
    const untouched = await classificationOf(done.id);
    expect(untouched.sentiment).toBe('positive');
    expect(untouched.topics).toEqual(['kept']);
    // …and the pending one took index 0, which is what proves the queue skipped
    // it rather than simply not running.
    expect((await classificationOf(pending.id)).topics).toEqual(['fresh']);
  });
});
