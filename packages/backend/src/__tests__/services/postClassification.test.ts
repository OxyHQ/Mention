import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClassificationTopicRef } from '@mention/shared-types';

/**
 * Unit coverage for the AI post-classification batch service.
 *
 * The Alia AI gateway and the Post model are mocked — no network and no DB. We
 * drive the service's `processQueue()` with canned Alia responses across every
 * category the issue requires (positive, neutral, mixed/constructive, toxic,
 * spammy, low-quality) plus the failure/retry path, and assert on the exact
 * `postClassification` documents the service persists via `bulkWrite`.
 *
 * Two invariants are checked throughout:
 *  - classification is independent of hashtags (none are read or written);
 *  - no provider/model string is ever written onto the post document.
 */

// --- Force classification ON for this suite (gated OFF by default). ---
vi.mock('../../config', () => ({
  config: {
    classification: { enabled: true },
    alia: { apiUrl: 'http://alia.test', apiKey: 'test-key', model: 'alia-v1', timeoutMs: 30_000 },
  },
}));

const aliaJSON = vi.fn();
const isAliaEnabled = vi.fn().mockReturnValue(true);
vi.mock('../../utils/alia', () => ({
  aliaJSON: (...args: unknown[]) => aliaJSON(...args),
  isAliaEnabled: () => isAliaEnabled(),
}));

// --- Mock the Post model with a chainable find() query builder. ---
interface MockPostDoc {
  _id: string;
  content: { text: string };
  createdAt: Date;
  postClassification?: { attempts?: number };
}

interface BulkOp {
  updateOne: {
    filter: { _id: string };
    update: { $set: Record<string, unknown> };
  };
}

const findResult: { docs: MockPostDoc[] } = { docs: [] };
const bulkWrite = vi.fn().mockResolvedValue({});
const updateMany = vi.fn().mockResolvedValue({});

function makeQuery(docs: MockPostDoc[]) {
  const query = {
    select: () => query,
    sort: () => query,
    limit: () => query,
    lean: () => Promise.resolve(docs),
  };
  return query;
}

const find = vi.fn((_filter?: unknown) => makeQuery(findResult.docs));

vi.mock('../../models/Post', () => ({
  Post: {
    find: (filter?: unknown) => find(filter),
    bulkWrite: (ops: unknown) => bulkWrite(ops),
    updateMany: (filter: unknown, update: unknown) => updateMany(filter, update),
  },
}));

// --- Mock TopicService registry resolution (no Oxy network). ---
// By default each slug resolves to a deterministic `topicId` (`topic:<name>`) so
// the canonical `topicRefs` carry registry linkage; individual tests can override
// to assert the name-only fallback when resolution returns no id.
const resolveTopicRefs = vi.fn(
  async (
    topics: Array<{ name: string; relevance?: number; type?: 'topic' | 'entity' }>,
  ): Promise<ClassificationTopicRef[]> =>
    topics.map(t => ({
      name: t.name,
      topicId: `topic:${t.name}`,
      ...(typeof t.relevance === 'number' ? { relevance: t.relevance } : {}),
      ...(t.type ? { type: t.type } : {}),
    })),
);
vi.mock('../../services/TopicService', () => ({
  topicService: {
    resolveTopicRefs: (topics: Array<{ name: string }>) => resolveTopicRefs(topics),
  },
}));

// Imported AFTER the mocks so the singleton wires to the mocked deps.
import { postClassificationService } from '../../services/PostClassificationService';

function post(id: string, text: string, attempts = 0): MockPostDoc {
  return { _id: id, content: { text }, createdAt: new Date(), postClassification: { attempts } };
}

/** Pull the $set payload the service wrote for a given post id. */
function setFor(id: string): Record<string, unknown> | undefined {
  for (const call of bulkWrite.mock.calls) {
    const ops = call[0] as BulkOp[];
    const op = ops.find(o => o.updateOne.filter._id === id);
    if (op) return op.updateOne.update.$set;
  }
  return undefined;
}

/**
 * Collapse the dotted `postClassification.*` keys of a $set into a nested object.
 * The success path now writes a DOTTED $set (so Stage-A baseline fields are
 * preserved through AI enrichment instead of being overwritten), so this
 * reconstructs the classification view the assertions read. Throws when no $set
 * was written for the id (a missing write is itself a test failure).
 */
function classificationFor(id: string): Record<string, unknown> {
  const set = setFor(id);
  if (!set) throw new Error(`no $set written for post '${id}'`);
  const prefix = 'postClassification.';
  const classification: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(set)) {
    if (key.startsWith(prefix)) classification[key.slice(prefix.length)] = value;
  }
  return classification;
}

beforeEach(() => {
  vi.clearAllMocks();
  isAliaEnabled.mockReturnValue(true);
  findResult.docs = [];
  resolveTopicRefs.mockImplementation(
    async (topics: Array<{ name: string; relevance?: number; type?: 'topic' | 'entity' }>) =>
      topics.map(t => ({
        name: t.name,
        topicId: `topic:${t.name}`,
        ...(typeof t.relevance === 'number' ? { relevance: t.relevance } : {}),
        ...(t.type ? { type: t.type } : {}),
      })),
  );
});

describe('PostClassificationService — category classification', () => {
  it('classifies positive product feedback', async () => {
    findResult.docs = [post('p1', 'I love how much faster the Mention feed feels now.')];
    aliaJSON.mockResolvedValue([
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

    const classification = classificationFor('p1');
    expect(classification).toBeDefined();
    expect(classification.status).toBe('classified');
    expect(classification.sentiment).toBe('positive');
    expect(classification.intent).toBe('feedback');
    expect(classification.topics).toEqual(['mention', 'product_feedback', 'feed']);
    expect(classification.classifiedAt).toBeInstanceOf(Date);
    const scores = classification.scores as Record<string, number>;
    expect(scores.toxicity).toBe(0);
    expect(scores.constructiveness).toBe(0.8);
  });

  it('classifies neutral posts', async () => {
    findResult.docs = [post('p2', 'Heading to the office, see you all later.')];
    aliaJSON.mockResolvedValue([
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

    const classification = classificationFor('p2');
    expect(classification.sentiment).toBe('neutral');
    expect(classification.intent).toBe('personal_update');
    expect(classification.status).toBe('classified');
  });

  it('classifies constructive mixed criticism with high constructiveness and low toxicity', async () => {
    findResult.docs = [post('p3', 'The new feed still breaks when refreshing, but the direction is good.')];
    aliaJSON.mockResolvedValue([
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

    const classification = classificationFor('p3');
    const scores = classification.scores as Record<string, number>;
    expect(classification.sentiment).toBe('mixed');
    // Constructive criticism: negative but not toxic, and highly constructive.
    expect(scores.toxicity).toBe(0);
    expect(scores.constructiveness).toBeGreaterThan(0.5);
    expect(scores.negativity).toBeGreaterThan(0);
  });

  it('classifies toxic complaints with high toxicity and low constructiveness', async () => {
    findResult.docs = [post('p4', 'This is trash and everyone here is stupid.')];
    aliaJSON.mockResolvedValue([
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

    const classification = classificationFor('p4');
    const scores = classification.scores as Record<string, number>;
    expect(classification.sentiment).toBe('negative');
    expect(scores.toxicity).toBeGreaterThan(0.5);
    expect(scores.constructiveness).toBeLessThan(0.2);
  });

  it('classifies spammy posts with high spam score', async () => {
    findResult.docs = [post('p5', 'FREE CRYPTO!!! Click here to claim 1000x returns now!!!')];
    aliaJSON.mockResolvedValue([
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

    const classification = classificationFor('p5');
    const scores = classification.scores as Record<string, number>;
    expect(scores.spam).toBeGreaterThan(0.5);
    expect(scores.quality).toBeLessThan(0.5);
  });

  it('classifies low-quality posts with low quality score', async () => {
    findResult.docs = [post('p6', 'k')];
    aliaJSON.mockResolvedValue([
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

    const classification = classificationFor('p6');
    const scores = classification.scores as Record<string, number>;
    expect(scores.quality).toBeLessThan(0.2);
    expect(classification.topics).toEqual([]);
  });

  it('classifies a mixed batch of multiple posts by postIndex', async () => {
    findResult.docs = [
      post('a', 'Great release today!'),
      post('b', 'This app is garbage.'),
    ];
    aliaJSON.mockResolvedValue([
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

    expect(classificationFor('a')?.sentiment).toBe('positive');
    expect(classificationFor('b')?.sentiment).toBe('negative');
  });
});

describe('PostClassificationService — provider/model isolation', () => {
  it('never writes a provider/model string onto the post document', async () => {
    findResult.docs = [post('p7', 'A normal post about coffee.')];
    aliaJSON.mockResolvedValue([
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

    const classification = classificationFor('p7');
    const serialized = JSON.stringify(classification).toLowerCase();
    for (const banned of ['gemini', 'openai', 'anthropic', 'alia', 'gpt', 'claude', 'model', 'provider']) {
      expect(serialized).not.toContain(banned);
    }
    // Only the product-facing fields are written (plus the internal attempts counter).
    expect(Object.keys(classification).sort()).toEqual(
      ['attempts', 'classifiedAt', 'confidence', 'intent', 'scores', 'sentiment', 'status', 'topics', 'topicRefs'].sort(),
    );
  });

  it('does not read or write hashtags (classification is independent of hashtags)', async () => {
    findResult.docs = [post('p8', 'Loving the new design #mention #ui #ux')];
    aliaJSON.mockResolvedValue([
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

    // The model `find` selected only text/createdAt/attempts — hashtags were never queried.
    const selectArg = find.mock.calls.length;
    expect(selectArg).toBeGreaterThan(0);
    const set = setFor('p8') as Record<string, unknown>;
    expect(set).toBeDefined();
    // The dotted $set only touches `postClassification.*` AI fields — no
    // top-level `hashtags` (or any non-classification) key is written.
    for (const key of Object.keys(set)) {
      expect(key.startsWith('postClassification.')).toBe(true);
    }
    expect(set['postClassification.hashtagsNorm']).toBeUndefined();
    // Inferred topics, not the user's hashtags.
    const classification = classificationFor('p8');
    expect(classification?.topics).toEqual(['design', 'product_feedback']);
  });
});

describe('PostClassificationService — Stage-A baseline preservation', () => {
  it('preserves the Stage-A deterministic fields through AI enrichment (dotted merge)', async () => {
    findResult.docs = [post('baseline_post', 'I love how much faster the Mention feed feels now.')];
    aliaJSON.mockResolvedValue([
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

    const set = setFor('baseline_post');
    expect(set).toBeDefined();
    // The AI stage uses a DOTTED $set — it MUST NOT write the whole subdoc, or it
    // would wipe the Stage-A fields. So the update touches ONLY AI-owned keys and
    // leaves language/region/hashtagsNorm/version/sensitive untouched in the doc.
    expect(set?.postClassification).toBeUndefined(); // no whole-subdoc overwrite
    expect(Object.keys(set ?? {}).sort()).toEqual(
      [
        'postClassification.topics',
        'postClassification.topicRefs',
        'postClassification.sentiment',
        'postClassification.intent',
        'postClassification.scores',
        'postClassification.confidence',
        'postClassification.status',
        'postClassification.attempts',
        'postClassification.classifiedAt',
      ].sort(),
    );
    // None of the Stage-A keys appear in the $set (they are preserved, not rewritten).
    for (const stageAKey of [
      'postClassification.language',
      'postClassification.region',
      'postClassification.hashtagsNorm',
      'postClassification.version',
      'postClassification.sensitive',
    ]) {
      expect(set?.[stageAKey]).toBeUndefined();
    }
    // AI fields are added and the post reaches `classified`.
    const classification = classificationFor('baseline_post');
    expect(classification?.status).toBe('classified');
    expect(classification?.sentiment).toBe('positive');
    expect(classification?.topics).toEqual(['mention', 'feed', 'product_feedback']);
  });
});

describe('PostClassificationService — canonical topicRefs resolution', () => {
  it('resolves AI-refined topics into registry-linked topicRefs (preserving topicId linkage)', async () => {
    findResult.docs = [post('refs_post', 'A post about basketball and the lakers.')];
    aliaJSON.mockResolvedValue([
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

    // The registry resolver was called once for the batch with the unique slugs.
    expect(resolveTopicRefs).toHaveBeenCalledTimes(1);
    expect(resolveTopicRefs.mock.calls[0][0]).toEqual([{ name: 'basketball' }, { name: 'lakers' }]);

    // The canonical topicRefs carry the same names AND the resolved topicIds, in
    // order — the linkage personalization/trending depend on.
    const set = setFor('refs_post');
    expect(set?.['postClassification.topicRefs']).toEqual([
      { name: 'basketball', topicId: 'topic:basketball' },
      { name: 'lakers', topicId: 'topic:lakers' },
    ]);
    // The lightweight slug list mirrors the same topics.
    expect(set?.['postClassification.topics']).toEqual(['basketball', 'lakers']);
  });

  it('falls back to name-only topicRefs when the registry resolves no id', async () => {
    findResult.docs = [post('refs_noid', 'A post about an obscure niche topic.')];
    aliaJSON.mockResolvedValue([
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

    const set = setFor('refs_noid');
    expect(set?.['postClassification.topicRefs']).toEqual([{ name: 'obscure_topic' }]);
  });

  it('stores name-only topicRefs when registry resolution throws (never drops the canonical list)', async () => {
    findResult.docs = [post('refs_throw', 'A post about coffee and espresso.')];
    aliaJSON.mockResolvedValue([
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

    // The post is still classified and the topicRefs preserve the names (no id).
    const set = setFor('refs_throw');
    expect(set?.['postClassification.status']).toBe('classified');
    expect(set?.['postClassification.topicRefs']).toEqual([
      { name: 'coffee' },
      { name: 'espresso' },
    ]);
  });

  it('writes an empty topicRefs list when the AI returns no topics', async () => {
    findResult.docs = [post('refs_empty', 'gm everyone')];
    aliaJSON.mockResolvedValue([
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

    // No topics → resolver not called, topicRefs is an empty list.
    expect(resolveTopicRefs).not.toHaveBeenCalled();
    const set = setFor('refs_empty');
    expect(set?.['postClassification.topicRefs']).toEqual([]);
  });
});

describe('PostClassificationService — failure and retry behavior', () => {
  it('marks posts pending (retry) on AI network failure under the retry budget', async () => {
    findResult.docs = [post('f1', 'A post that will fail to classify.', 0)];
    aliaJSON.mockRejectedValue(new Error('network down'));

    await postClassificationService.processQueue();

    const set = setFor('f1');
    expect(set?.['postClassification.status']).toBe('pending');
    expect(set?.['postClassification.attempts']).toBe(1);
  });

  it('flips to failed once the retry budget is exhausted', async () => {
    // attempts already at 2 → next attempt (3) hits MAX_ATTEMPTS and expires.
    findResult.docs = [post('f2', 'A persistently failing post.', 2)];
    aliaJSON.mockRejectedValue(new Error('still down'));

    await postClassificationService.processQueue();

    const set = setFor('f2');
    expect(set?.['postClassification.status']).toBe('failed');
    expect(set?.['postClassification.attempts']).toBe(3);
    expect(set?.['postClassification.classifiedAt']).toBeInstanceOf(Date);
  });

  it('marks posts for retry when the AI response fails schema validation', async () => {
    findResult.docs = [post('f3', 'Schema-busting response incoming.', 0)];
    // score out of range → zod validation fails → whole batch retried.
    aliaJSON.mockResolvedValue([
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

    const set = setFor('f3');
    expect(set?.['postClassification.status']).toBe('pending');
    expect(set?.['postClassification.attempts']).toBe(1);
  });

  it('counts an attempt for a post missing from the AI response', async () => {
    findResult.docs = [
      post('present', 'This one got classified.', 0),
      post('missing', 'This one was dropped by the model.', 0),
    ];
    aliaJSON.mockResolvedValue([
      {
        postIndex: 0,
        topics: ['ok'],
        sentiment: 'neutral',
        intent: 'other',
        scores: { toxicity: 0, constructiveness: 0, spam: 0, quality: 0.5, controversy: 0, negativity: 0 },
        confidence: 0.7,
      },
    ]);

    await postClassificationService.processQueue();

    expect(classificationFor('present')?.status).toBe('classified');
    const missing = setFor('missing');
    expect(missing?.['postClassification.status']).toBe('pending');
    expect(missing?.['postClassification.attempts']).toBe(1);
  });

  it('no-ops when classification is disabled or Alia is unavailable', async () => {
    findResult.docs = [post('p9', 'Should not be processed when Alia is off.')];
    isAliaEnabled.mockReturnValue(false);

    await postClassificationService.processQueue();

    expect(aliaJSON).not.toHaveBeenCalled();
    expect(bulkWrite).not.toHaveBeenCalled();
  });
});
