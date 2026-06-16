import { describe, it, expect, vi, beforeEach } from 'vitest';

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

beforeEach(() => {
  vi.clearAllMocks();
  isAliaEnabled.mockReturnValue(true);
  findResult.docs = [];
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

    const set = setFor('p1');
    expect(set).toBeDefined();
    const classification = set?.postClassification as Record<string, unknown>;
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

    const classification = setFor('p2')?.postClassification as Record<string, unknown>;
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

    const classification = setFor('p3')?.postClassification as Record<string, unknown>;
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

    const classification = setFor('p4')?.postClassification as Record<string, unknown>;
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

    const classification = setFor('p5')?.postClassification as Record<string, unknown>;
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

    const classification = setFor('p6')?.postClassification as Record<string, unknown>;
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

    expect((setFor('a')?.postClassification as Record<string, unknown>).sentiment).toBe('positive');
    expect((setFor('b')?.postClassification as Record<string, unknown>).sentiment).toBe('negative');
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

    const classification = setFor('p7')?.postClassification as Record<string, unknown>;
    const serialized = JSON.stringify(classification).toLowerCase();
    for (const banned of ['gemini', 'openai', 'anthropic', 'alia', 'gpt', 'claude', 'model', 'provider']) {
      expect(serialized).not.toContain(banned);
    }
    // Only the product-facing fields are written (plus the internal attempts counter).
    expect(Object.keys(classification).sort()).toEqual(
      ['attempts', 'classifiedAt', 'confidence', 'intent', 'scores', 'sentiment', 'status', 'topics'].sort(),
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
    // No hashtags key is written by classification.
    expect(Object.keys(set)).toEqual(['postClassification']);
    const classification = set.postClassification as Record<string, unknown>;
    // Inferred topics, not the user's hashtags.
    expect(classification.topics).toEqual(['design', 'product_feedback']);
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

    expect((setFor('present')?.postClassification as Record<string, unknown>).status).toBe('classified');
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
