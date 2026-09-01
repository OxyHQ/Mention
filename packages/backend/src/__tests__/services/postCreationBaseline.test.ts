import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the Stage-A deterministic classification wiring inside
 * {@link PostCreationService.create} — the single chokepoint for native post
 * creation AND every single-federated ingest path (inbox handleCreate, boost
 * import, boosted-note import).
 *
 * Invariants checked:
 *  - native create populates the Stage-A baseline fields (topics, languages,
 *    hashtagsNorm, version, classifiedAt) AND keeps `status: 'pending'` so the
 *    async AI batch still enriches the post;
 *  - a federated note's AP-declared language reaches BOTH the top-level
 *    `post.language` (primary) and the Stage-A `postClassification.languages`;
 *  - mentions are reconciled against the FINALIZED stored bodies;
 *  - a classifier throw is caught and NEVER blocks post creation.
 *
 * ## What changed with the Postgres port
 *
 * This suite used to replace `models/Post` with a class that pushed its
 * constructor argument onto an array, and then asserted on that argument. That
 * measures what the service ASSEMBLED, which is a strictly weaker claim than
 * what the database HOLDS — it cannot see a field that never reaches a column,
 * a value the schema coerces, or the difference between "written as absent" and
 * "defaulted by the table". `postClassification` is now fifteen real columns
 * plus a child table, so every assertion here reads the post back through
 * `loadPostRecord`, the same call every production reader makes.
 *
 * One assertion moved rather than survived: "no Stage-A subdoc was set on
 * failure" was `expect(doc.postClassification).toBeUndefined()`, which the
 * relational schema cannot express — `classification_status` is `NOT NULL
 * DEFAULT 'pending'`. The equivalent, and the thing that actually matters, is
 * that the post exists and carries NO baseline signal (no version, no
 * classifiedAt, no languages) while still being queued at `pending`.
 *
 * The side-effect collaborators (notifications, subscriptions, federation
 * delivery, socket hydration) stay mocked so the suite isolates classification.
 * The classifier itself is pure and is NOT mocked — the happy paths exercise the
 * real deterministic baseline; the failure test forces a throw with `vi.spyOn`.
 */

vi.mock('../../utils/notificationUtils', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  createMentionNotifications: vi.fn().mockResolvedValue(undefined),
  createBatchNotifications: vi.fn().mockResolvedValue(undefined),
  createPostAuthorNotifications: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/serviceRegistry', () => ({
  getPostFederator: () => ({ federateNewPost: vi.fn().mockResolvedValue(undefined) }),
  registerPostCreator: vi.fn(),
}));

// The socket emit hydrates the created post via PostHydrationService before
// broadcasting `feed:updated`. These tests pass `skipSocketEmit: true`, so the
// hydration path is never exercised; mock it to a no-op so importing
// PostCreationService does not pull in the heavy `../../server` module graph.
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getUsersByIds: vi.fn().mockResolvedValue([]) }),
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import {
  clearServiceScope,
  readPost,
  serviceScope,
  trackPost,
  withDeadlockRetry,
} from '../helpers/serviceFixtures';
import { postCreationService } from '../../services/PostCreationService';
import { baselineContentClassifier } from '../../services/BaselineContentClassifier';
import { PostVisibility } from '@mention/shared-types';
import type { PostRecord } from '../../db/posts/postRecord';

const scope = serviceScope('post-creation-baseline');

/** Create through the real service and read the row back out of Postgres. */
async function createAndReload(
  params: Parameters<typeof postCreationService.create>[0],
): Promise<PostRecord> {
  // Retried on `40P01` only: ten suites write `posts` concurrently and its four
  // self-referencing foreign keys make bulk statements contend for locks in
  // different orders. See `withDeadlockRetry`.
  const created = await withDeadlockRetry(() => postCreationService.create(params));
  trackPost(scope, created.id);
  const stored = await readPost(created.id);
  if (!stored) throw new Error(`post ${created.id} was not readable after create`);
  return stored;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await clearServiceScope(scope);
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('PostCreationService — native Stage-A baseline', () => {
  it('persists the Stage-A baseline fields and keeps the classification pending', async () => {
    const post = await createAndReload({
      oxyUserId: scope.user('native'),
      content: {
        text: 'I love how much faster the feed feels now, this is genuinely great news for everyone. #ai',
      },
      hashtags: ['ai'],
      visibility: PostVisibility.PUBLIC,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    const classification = post.postClassification;
    // Status MUST remain pending so the async AI batch still enriches the post.
    expect(classification.status).toBe('pending');
    expect(classification.attempts).toBe(0);
    // The subdoc carries ONLY the multi-language array; the primary lives on the
    // top-level `post.language`.
    expect(classification.languages).toEqual(['en']);
    expect(post.language).toBe('en');
    expect(classification.version).toBeGreaterThan(0);
    expect(classification.classifiedAt).toBeInstanceOf(Date);
    expect(classification.hashtagsNorm).toContain('ai');
    expect(classification.topics).toContain('ai');
    // Deterministic scores are seeded so ranking can act on them pre-AI. They
    // are `numeric` columns, so this also pins that they survive as NUMBERS
    // rather than the strings postgres.js hands back for undeclared numerics.
    expect(typeof classification.scores.spam).toBe('number');
    expect(classification.scores.spam).toBeGreaterThanOrEqual(0);
    expect(classification.scores.quality).toBeGreaterThan(0);
    expect(classification.scores.toxicity).toBeGreaterThanOrEqual(0);
  });

  it("threads a federated note's AP language into both post.language and the baseline", async () => {
    const post = await createAndReload({
      oxyUserId: scope.user('federated-de'),
      content: { text: 'Guten Morgen zusammen, das ist ein ganz normaler deutscher Beitrag.' },
      // The inbox handler passes the AP-derived language here (extractApLanguage).
      language: 'de',
      instanceDomain: 'social.example.de',
      // The activity id is namespaced to THIS suite; only `instanceDomain` drives
      // the coarse region, so it does not have to live on the ccTLD host.
      federation: { activityId: `https://${scope.name}.test/statuses/1`, sensitive: false },
      visibility: PostVisibility.PUBLIC,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    // Top-level AP language reflects the resolved primary, not the column default.
    expect(post.language).toBe('de');
    expect(post.postClassification.languages).toEqual(['de']);
    // Region derived from the ccTLD federated instance.
    expect(post.postClassification.region).toBe('DE');
    expect(post.postClassification.status).toBe('pending');
    // The federation subdoc is what makes `federation == null` the "is this
    // ours?" test everywhere else, so it has to have survived the write.
    expect(post.federation?.activityId).toBe(`https://${scope.name}.test/statuses/1`);
  });

  it("threads a federated note's declared multi-language set into postClassification.languages", async () => {
    const post = await createAndReload({
      oxyUserId: scope.user('federated-multi'),
      content: { text: 'This English body, but the AP source declared two languages via contentMap.' },
      // The inbox/outbox handlers pass extractApLanguage (primary) + extractApLanguages (full set).
      language: 'en',
      languages: ['en', 'es'],
      instanceDomain: 'mastodon.example.com',
      federation: { activityId: `https://${scope.name}.test/statuses/2`, sensitive: false },
      visibility: PostVisibility.PUBLIC,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    // Top-level AP scalar is the primary; the classification records BOTH, in
    // declared order — an array column, so the order is a real stored fact.
    expect(post.language).toBe('en');
    expect(post.postClassification.languages).toEqual(['en', 'es']);
  });

  it('persists only mention ids that still occur in a stored author body', async () => {
    const post = await createAndReload({
      oxyUserId: scope.user('mentions'),
      content: {
        text: 'ignored when author variants exist',
        variants: [
          { source: 'author', tag: 'en', text: 'Hello [mention:alice-id]' },
          { source: 'author', tag: 'es', text: 'Hola [mention:bob-id]' },
          { source: 'machine', tag: 'it', text: 'Ciao [mention:machine-only]' },
        ],
      },
      mentions: ['orphan-id', 'bob-id', 'alice-id', 'machine-only'],
      visibility: PostVisibility.PUBLIC,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    // `post_mentions` is its own table and it is the notification allowlist: an
    // id that survived here would notify someone the body never names.
    //
    // Compared as a SET. `assemblePostRecords` reads the rows `order by id`, and
    // the id is a per-row uuid v7 whose random tail decides ties between two
    // mentions written in the same millisecond — so the stored order is not the
    // body order and is not reproducible. Nothing consumes mention ORDER (it is
    // an allowlist), but an assertion that depended on it would flake.
    expect([...post.mentions].sort()).toEqual(['alice-id', 'bob-id']);
  });

  it('does NOT block post creation when the classifier throws', async () => {
    vi.spyOn(baselineContentClassifier, 'classify').mockImplementation(() => {
      throw new Error('classifier boom');
    });

    const post = await createAndReload({
      oxyUserId: scope.user('classifier-throws'),
      content: { text: 'a post that survives a classifier failure' },
      visibility: PostVisibility.PUBLIC,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    // The row landed — classification is best-effort and must never gate a write.
    expect(post.status).toBe('published');
    expect(post.content.variants[0].text).toBe('a post that survives a classifier failure');
    // No Stage-A signal was stamped, so nothing downstream can mistake the
    // default-zero scores for a real verdict: ranking gates on `version`.
    expect(post.postClassification.version).toBeUndefined();
    expect(post.postClassification.classifiedAt).toBeUndefined();
    expect(post.postClassification.languages).toBeUndefined();
    // And the post is still QUEUED for the AI batch rather than marked done.
    expect(post.postClassification.status).toBe('pending');
    expect(post.postClassification.attempts).toBe(0);
  });
});
