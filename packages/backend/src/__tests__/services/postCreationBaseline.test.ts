import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit coverage for the Stage-A deterministic classification wiring inside
 * {@link PostCreationService.create} — the single chokepoint for native post
 * creation AND every single-federated ingest path (inbox handleCreate, boost
 * import, boosted-note import).
 *
 * The Post model is mocked with a constructor that captures the document data
 * passed to `new Post(...)`, so we can assert exactly which `postClassification`
 * fields the service seeds before save. All side-effect collaborators
 * (notifications, subscriptions, federation delivery, socket) are mocked to
 * no-ops so the test isolates the classification behavior.
 *
 * Invariants checked:
 *  - native create populates the Stage-A baseline fields (topics, languages,
 *    hashtagsNorm, version, classifiedAt) AND keeps `status: 'pending'` so the
 *    async AI batch still enriches the post;
 *  - a federated note's AP-declared language is threaded through to the top-level
 *    `post.language` (primary) and the Stage-A `postClassification.languages`;
 *  - a classifier throw is caught and NEVER blocks post creation.
 */

// --- Capture every document handed to `new Post(...)`. ---
// Defined via `vi.hoisted` because `vi.mock` factories are hoisted above normal
// top-level declarations — referencing a plain `const`/`class` there throws
// "Cannot access ... before initialization".
const { savedDocs, MockPost, postFindLean } = vi.hoisted(() => {
  const docs: Array<Record<string, unknown>> = [];
  class HoistedMockPost {
    [key: string]: unknown;
    constructor(data: Record<string, unknown>) {
      Object.assign(this, data);
      docs.push(data);
    }
    save = vi.fn().mockResolvedValue(undefined);
    toObject(): Record<string, unknown> {
      return { ...this };
    }
    _id = 'mock_post_id';
  }
  return {
    savedDocs: docs,
    MockPost: HoistedMockPost,
    postFindLean: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('../../models/Post', async () => {
  const actual = await vi.importActual<typeof import('../../models/Post')>('../../models/Post');
  return {
    // Re-export the real constant so the service's pending status matches.
    POST_CLASSIFICATION_PENDING: actual.POST_CLASSIFICATION_PENDING,
    Post: Object.assign(MockPost, {
      find: () => ({ select: () => ({ lean: () => postFindLean() }) }),
    }),
  };
});

vi.mock('../../utils/notificationUtils', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  createMentionNotifications: vi.fn().mockResolvedValue(undefined),
  createBatchNotifications: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../models/PostSubscription', () => ({
  default: { find: () => ({ lean: () => Promise.resolve([]) }) },
}));

vi.mock('../../services/serviceRegistry', () => ({
  getPostFederator: () => ({ federateNewPost: vi.fn().mockResolvedValue(undefined) }),
  registerPostCreator: vi.fn(),
}));

// The classifier is pure, so it is NOT mocked — happy-path tests exercise the
// real deterministic baseline. The failure test forces a throw via vi.spyOn.
// Imported AFTER the model/side-effect mocks so the singleton wires to them.
import { postCreationService } from '../../services/PostCreationService';
import { baselineContentClassifier } from '../../services/BaselineContentClassifier';
import { PostVisibility } from '@mention/shared-types';

function lastSavedDoc(): Record<string, unknown> {
  expect(savedDocs.length).toBeGreaterThan(0);
  return savedDocs[savedDocs.length - 1];
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  savedDocs.length = 0;
  postFindLean.mockResolvedValue([]);
});

describe('PostCreationService — native Stage-A baseline', () => {
  it('populates the Stage-A baseline fields and keeps status pending', async () => {
    await postCreationService.create({
      oxyUserId: 'oxy_user_1',
      content: { text: 'I love how much faster the feed feels now, this is genuinely great news for everyone. #ai' },
      hashtags: ['ai'],
      visibility: PostVisibility.PUBLIC,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    const doc = lastSavedDoc();
    const classification = doc.postClassification as Record<string, unknown>;
    expect(classification).toBeDefined();
    // Status MUST remain pending so the async AI batch still enriches the post.
    expect(classification.status).toBe('pending');
    expect(classification.attempts).toBe(0);
    // Deterministic baseline is filled. The subdoc carries ONLY the multi-language
    // array; the primary lives on the top-level `post.language`.
    expect(classification.languages).toEqual(['en']);
    expect(classification.language).toBeUndefined();
    expect((doc as Record<string, unknown>).language).toBe('en');
    expect(classification.version).toBeGreaterThan(0);
    expect(classification.classifiedAt).toBeInstanceOf(Date);
    expect(classification.hashtagsNorm).toContain('ai');
    expect(classification.topics).toContain('ai');
    // Deterministic scores are seeded so ranking can act on them pre-AI.
    const scores = classification.scores as { spam: number; quality: number; toxicity: number };
    expect(scores).toBeDefined();
    expect(scores.spam).toBeGreaterThanOrEqual(0);
    expect(scores.quality).toBeGreaterThanOrEqual(0);
    expect(scores.toxicity).toBeGreaterThanOrEqual(0);
  });

  it('threads a federated note\'s AP language into both post.language and the baseline', async () => {
    await postCreationService.create({
      oxyUserId: 'oxy_user_2',
      content: { text: 'Guten Morgen zusammen, das ist ein ganz normaler deutscher Beitrag.' },
      // The inbox handler passes the AP-derived language here (extractApLanguage).
      language: 'de',
      instanceDomain: 'social.example.de',
      federation: { activityId: 'https://social.example.de/users/x/statuses/1', sensitive: false },
      visibility: PostVisibility.PUBLIC,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    const doc = lastSavedDoc();
    // Top-level AP language reflects the resolved primary, not the schema default.
    expect(doc.language).toBe('de');
    const classification = doc.postClassification as Record<string, unknown>;
    // The subdoc carries ONLY the multi-language array (single field removed).
    expect(classification.language).toBeUndefined();
    expect(classification.languages).toEqual(['de']);
    // Region derived from the ccTLD federated instance.
    expect(classification.region).toBe('DE');
    expect(classification.status).toBe('pending');
  });

  it('threads a federated note\'s declared multi-language set into postClassification.languages', async () => {
    await postCreationService.create({
      oxyUserId: 'oxy_user_multi',
      content: { text: 'This English body, but the AP source declared two languages via contentMap.' },
      // The inbox/outbox handlers pass extractApLanguage (primary) + extractApLanguages (full set).
      language: 'en',
      languages: ['en', 'es'],
      instanceDomain: 'mastodon.example.com',
      federation: { activityId: 'https://mastodon.example.com/users/x/statuses/2', sensitive: false },
      visibility: PostVisibility.PUBLIC,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    const doc = lastSavedDoc();
    // Top-level AP scalar is the primary; the classification records BOTH languages.
    expect(doc.language).toBe('en');
    const classification = doc.postClassification as Record<string, unknown>;
    // The subdoc carries ONLY the multi-language array (single field removed).
    expect(classification.language).toBeUndefined();
    expect(classification.languages).toEqual(['en', 'es']);
  });

  it('does NOT block post creation when the classifier throws', async () => {
    vi.spyOn(baselineContentClassifier, 'classify').mockImplementation(() => {
      throw new Error('classifier boom');
    });

    const post = await postCreationService.create({
      oxyUserId: 'oxy_user_3',
      content: { text: 'a post that survives a classifier failure' },
      visibility: PostVisibility.PUBLIC,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    // The post was still created (save ran) — classification is best-effort.
    expect(post).toBeDefined();
    expect((post as unknown as InstanceType<typeof MockPost>).save).toHaveBeenCalledTimes(1);
    const doc = lastSavedDoc();
    // No Stage-A subdoc was set on failure; the schema default seeds `pending`.
    expect(doc.postClassification).toBeUndefined();
  });
});
