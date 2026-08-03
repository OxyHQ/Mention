import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaseEnvelopeSchema } from '@oxyhq/crowdsource-contracts';
import { PostType, PostVisibility } from '@mention/shared-types';

/**
 * The subject-provider seam — the part a second application actually writes.
 *
 * These assert the two things a provider can get wrong in a way nothing else
 * would catch: producing material a jury cannot use, and producing DIFFERENT
 * material for the same object on two deliveries. The second one is the
 * dangerous half — ingress fingerprints the whole envelope, so an unstable
 * snapshot turns a legitimate outbox retry into a permanent 409, days later.
 *
 * ## What changed with the Postgres port
 *
 * `postSubject.loadPost` is `loadPostRecord` now, so the provider reads an
 * ASSEMBLED record: the body comes out of `post_content_variants`, the author
 * out of `post_authorships`, and the parent/quote context out of two more reads
 * of the same tables. The old suite mocked `models/Post.findById` over a `Map`
 * and handed the provider hand-built documents, so the snapshot was assembled
 * from the literal the test wrote — it could not see a variant that failed to
 * round-trip, an authorship row that never landed, or a language tag the column
 * normalized.
 *
 * That matters more here than in most suites, because the property under test is
 * BYTE STABILITY across two deliveries. A snapshot built from a fixed literal is
 * stable by construction; a snapshot built from two independent reads of a
 * normalized schema is stable only if the reads agree — including the ORDER the
 * variant and authorship rows come back in, which is exactly the kind of thing
 * that silently differs between two queries and only shows up as a 409 days
 * later.
 */

const getUserById = vi.fn();

vi.mock('../../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ getUserById }),
}));

import { closePostgres, connectPostgres } from '../../../db/postgres';
import { clearServiceScope, seedPost, serviceScope } from '../../helpers/serviceFixtures';
import { deletePostRecord, replacePostContent } from '../../../db/posts/postRepository';
import type { PostRecord, PostRecordInput } from '../../../db/posts/postRecord';
import { buildModerationReportInput } from '../../../services/moderation/EvidenceSnapshotService';
import { createPostSubjectProvider } from '../../../services/moderation/subjects/postSubject';
import { createUserSubjectProvider } from '../../../services/moderation/subjects/userSubject';

const scope = serviceScope('moderation-subjects');
const AUTHOR = scope.user('author');
const REPORTER = scope.user('reporter');

/** A published, public, Spanish text post owned by this suite's author. */
function textPost(text: string, extra: Partial<PostRecordInput> = {}): Promise<PostRecord> {
  return seedPost(scope, {
    oxyUserId: AUTHOR,
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    content: { variants: [{ source: 'author', tag: 'es-ES', text }] },
    createdAt: new Date('2026-07-20T10:00:00.000Z'),
    ...extra,
  });
}

const postProvider = createPostSubjectProvider({
  reportedType: 'post' as const,
  subjectType: 'social.post',
});

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  await clearServiceScope(scope);
  vi.clearAllMocks();
});

afterEach(async () => {
  await clearServiceScope(scope);
  vi.restoreAllMocks();
});

describe('post subject provider', () => {
  it('describes the post as a text resource with its author and language', async () => {
    const post = await textPost('El texto exacto reportado.');

    const snapshot = await postProvider.snapshot(post.id);

    expect(snapshot).toMatchObject({
      subject: {
        externalId: post.id,
        type: 'social.post',
        // Read from the `post_authorships` OWNER row, not from the denormalized
        // `oxy_user_id` column — those are two different reads that a broken
        // authorship write would make disagree.
        author: { oxyUserId: AUTHOR },
      },
      content: {
        type: 'text',
        data: { text: 'El texto exacto reportado.' },
        language: 'es-ES',
      },
    });
  });

  it('returns null for a post that no longer exists', async () => {
    // Not an error: content deleted between the report and its delivery is
    // ordinary, and a provider that threw would make deletion look like an outage.
    const post = await textPost('About to be deleted.');
    expect(await postProvider.snapshot(post.id)).not.toBeNull();

    await deletePostRecord(post.id, undefined);
    expect(await postProvider.snapshot(post.id)).toBeNull();
    // An id no row could ever carry must also be a null, not a throw.
    expect(await postProvider.snapshot('not-an-object-id')).toBeNull();
  });

  it('drops a language tag the contract would refuse rather than failing the report', async () => {
    const post = await seedPost(scope, {
      oxyUserId: AUTHOR,
      content: { variants: [{ source: 'author', tag: 'not a tag', text: 'Body.' }] },
      createdAt: new Date('2026-07-20T10:00:00.000Z'),
    });
    // The column stored the tag verbatim — the provider, not the schema, is what
    // has to refuse it.
    expect(post.content.variants[0].tag).toBe('not a tag');

    const snapshot = await postProvider.snapshot(post.id);

    /**
     * An invalid tag makes envelope composition throw a non-retryable input
     * error. A report must not be undeliverable because a post carries an exotic
     * language tag — the tag is context, not evidence.
     */
    expect(snapshot?.content).not.toHaveProperty('language');
    expect(snapshot?.content).toMatchObject({ data: { text: 'Body.' } });
  });

  it('describes a post with no body as metadata rather than as empty text', async () => {
    const post = await seedPost(scope, {
      oxyUserId: AUTHOR,
      type: PostType.IMAGE,
      content: {
        media: [
          { id: 'file_1', type: 'image' },
          { id: 'file_2', type: 'image' },
        ],
      },
    });
    // No variant row at all — the relational shape of "this post has no body".
    // The assembler omits `variants` entirely rather than returning an empty
    // array, which is a distinction the provider has to survive.
    expect(post.content.variants).toBeUndefined();

    const snapshot = await postProvider.snapshot(post.id);

    /**
     * The contract refuses an empty text resource, and rightly. A `metadata`
     * resource says what the post consisted of without pretending to carry it —
     * so a jury can answer `insufficient_context` for the right reason while
     * Mention cannot yet ship the bytes (see `postSubject.ts`).
     */
    expect(snapshot?.content).toMatchObject({
      type: 'metadata',
      data: { bodyText: 'absent', mediaItems: 2, mediaKinds: 'image', evidenceAttached: false },
    });
  });

  it('carries the parent as context, with the right relation', async () => {
    const parent = await textPost('The post being replied to.');
    const post = await textPost('The reply.', { parentPostId: parent.id });

    const snapshot = await postProvider.snapshot(post.id);

    expect(snapshot?.context).toEqual([
      expect.objectContaining({
        role: 'parent',
        type: 'text',
        data: { text: 'The post being replied to.' },
      }),
    ]);
  });

  it('carries a QUOTED post as context under its own relation', async () => {
    const quoted = await textPost('The post being quoted.');
    const post = await textPost('The quote.', { quoteOf: quoted.id });

    const snapshot = await postProvider.snapshot(post.id);

    expect(snapshot?.context).toEqual([
      expect.objectContaining({
        role: 'quoted',
        type: 'text',
        data: { text: 'The post being quoted.' },
      }),
    ]);
  });

  it('omits context whose neighbour is gone', async () => {
    // `parent_post_id` is `ON DELETE SET NULL`, so a deleted parent leaves an
    // ORPHANED reply — `is_reply` stays true and the link is simply gone. That
    // state is legitimate and must not fail the report.
    const parent = await textPost('Soon to be deleted.');
    const post = await textPost('The reply.', { parentPostId: parent.id });
    await deletePostRecord(parent.id, undefined);

    const snapshot = await postProvider.snapshot(post.id);

    // A jury judging a reply needs what it replied to; a missing parent is
    // context that does not exist, not a reason to fail the report.
    expect(snapshot?.context).toBeUndefined();
    expect(snapshot?.content).toMatchObject({ data: { text: 'The reply.' } });
  });

  it('omits context whose neighbour carries no text', async () => {
    const parent = await seedPost(scope, {
      oxyUserId: AUTHOR,
      type: PostType.IMAGE,
      content: { media: [{ id: 'file_1', type: 'image' }] },
    });
    const post = await textPost('The reply.', { parentPostId: parent.id });

    expect((await postProvider.snapshot(post.id))?.context).toBeUndefined();
  });

  it('passes a declared content warning through as a provenance-named hint', async () => {
    const post = await textPost('Body.', { metadata: { isSensitive: true } });

    const snapshot = await postProvider.snapshot(post.id);

    // §5.2: a prior classification of exposure, never a verdict — and only what
    // the author or the origin instance ASSERTED, never Mention's classifier
    // score. `metadata_is_sensitive` and `classification_sensitive` are two
    // different columns, which is what makes that distinction storable.
    expect(snapshot?.content).toMatchObject({ sensitivity: 'author_marked_sensitive' });
  });

  it('does NOT pass Mention’s own classifier verdict off as the author’s', async () => {
    const post = await textPost('Body.', {
      metadata: {},
      postClassification: { status: 'classified', sensitive: true },
    });

    expect((await postProvider.snapshot(post.id))?.content).not.toHaveProperty('sensitivity');
  });
});

describe('user subject provider', () => {
  it('passes the Oxy profile through without recomposing a name', async () => {
    getUserById.mockResolvedValue({
      username: 'reported_account',
      name: { displayName: 'Reported Account', first: 'Reported', last: 'Account' },
      description: 'A bio that was reported.',
      website: 'https://example.com',
    });

    const snapshot = await createUserSubjectProvider().snapshot('oxy-user-1');

    expect(snapshot?.content).toEqual({
      type: 'profile',
      data: {
        displayName: 'Reported Account',
        bio: 'A bio that was reported.',
        claims: { username: 'reported_account', website: 'https://example.com' },
      },
    });
    // Consistency-critical read: the SDK's five-minute GET cache must not decide
    // what a jury reviews.
    expect(getUserById).toHaveBeenCalledWith('oxy-user-1', { cache: false });
  });

  it('omits a display name it does not have instead of substituting the handle', async () => {
    getUserById.mockResolvedValue({ username: 'federated_actor', name: {} });

    const snapshot = await createUserSubjectProvider().snapshot('oxy-user-2');

    // Every field of §5.3's profile resource is optional because an unresolved or
    // federated actor routinely has no display name.
    expect(snapshot?.content).toEqual({
      type: 'profile',
      data: { claims: { username: 'federated_actor' } },
    });
  });

  it('omits the permalink when there is no handle to build one from', async () => {
    getUserById.mockResolvedValue({ name: {} });

    const snapshot = await createUserSubjectProvider().snapshot('oxy-user-3');

    // `/@<oxyUserId>` is not a Mention profile URL. Emitting a raw id where a
    // handle belongs is the ghost-handle bug.
    expect(snapshot?.subject).not.toHaveProperty('permalink');
    expect(snapshot?.subject.externalId).toBe('oxy-user-3');
  });
});

describe('report input — what the SDK is handed', () => {
  /** The report row, minus the id of the post it is about (seeded per test). */
  function reportFor(postId: string) {
    return {
      id: '507f1f77bcf86cd799439011',
      reportedType: 'post' as const,
      reportedId: postId,
      reporter: REPORTER,
      categories: ['harassment', 'spam'],
      details: 'This account keeps targeting me.',
      createdAt: new Date('2026-07-28T18:00:00.000Z'),
    };
  }

  it('produces the same bytes for the same report every time', async () => {
    const post = await textPost('The reported text.');
    const report = reportFor(post.id);

    const first = await buildModerationReportInput(report);
    const second = await buildModerationReportInput(report);

    /**
     * The property that keeps an outbox retry from becoming a 409. Everything the
     * builder composes has to be derived from the report and the object — no
     * clock, no random id, no order that depends on how a client happened to send
     * its categories.
     *
     * Against real rows this now also covers the READS: two independent
     * assemblies of the same post, each joining the variant and authorship
     * tables, have to produce byte-identical material.
     */
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first?.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('produces the same bytes for a post carrying several variants and a collaborator', async () => {
    // The multi-row case, where an unordered read would actually differ: three
    // variant rows and two authorship rows for one post.
    const post = await seedPost(scope, {
      oxyUserId: AUTHOR,
      authorship: [
        { oxyUserId: AUTHOR, role: 'owner', status: 'accepted' },
        { oxyUserId: scope.user('collab'), role: 'collaborator', status: 'accepted' },
      ],
      content: {
        variants: [
          { source: 'author', tag: 'es-ES', text: 'El primero.' },
          { source: 'author', tag: 'en', text: 'The second.' },
          { source: 'machine', tag: 'it', text: 'Il terzo.' },
        ],
      },
      createdAt: new Date('2026-07-20T10:00:00.000Z'),
    });
    const report = reportFor(post.id);

    const first = await buildModerationReportInput(report);
    const second = await buildModerationReportInput(report);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // The PRIMARY rendition is what a jury reads — position 0, not whichever row
    // the planner happened to return first.
    expect(first?.reportInput.content).toMatchObject({ data: { text: 'El primero.' } });
    expect(first?.snapshotHash).toBe(second?.snapshotHash);
  });

  it('sorts allegations and attaches the reporter words to one of them', async () => {
    const post = await textPost('The reported text.');
    const report = reportFor(post.id);

    const built = await buildModerationReportInput(report);

    expect(built?.reportInput.allegations).toEqual([
      { code: 'harassment.targeted_abuse', details: 'This account keeps targeting me.' },
      { code: 'integrity.spam' },
    ]);
    // §6.2: details are the reporter's claim, never evidence for it — so they are
    // not repeated across codes as if written about each separately.
    expect(built?.reportInput.metadata).toMatchObject({
      taxonomyVersion: expect.any(String),
      categories: 'harassment,spam',
    });
    expect(built?.reportInput.submittedAt).toEqual(report.createdAt);
  });

  it('is composable into an envelope the published contract accepts', async () => {
    const post = await textPost('The reported text.');
    const report = reportFor(post.id);
    const built = await buildModerationReportInput(report);
    const input = built?.reportInput;
    if (!input) throw new Error('expected a report input');

    /**
     * The end-to-end check that the description is USABLE. The SDK composes the
     * envelope and validates it internally, but it does not export that function
     * — so this reproduces only the shape the SDK derives and validates it
     * against the contract, which is enough to catch a provider emitting a field
     * the envelope refuses.
     */
    const envelope = {
      schemaVersion: 'crowdsource.case.v1',
      applicationId: 'app_mention',
      externalReportId: input.externalReportId,
      subject: {
        externalId: input.subject.externalId,
        type: input.subject.type,
        primaryResourceId: 'res_subject',
        ...(input.subject.permalink === undefined ? {} : { permalink: input.subject.permalink }),
      },
      principalBindings: [
        {
          principalRef: 'p_author',
          type: 'oxy_user',
          externalPrincipalId: AUTHOR,
          bindingProofId: AUTHOR,
        },
        {
          principalRef: 'p_reporter',
          type: 'oxy_user',
          externalPrincipalId: report.reporter,
          bindingProofId: report.reporter,
        },
      ],
      resources: [
        {
          ...(typeof input.content === 'string'
            ? { type: 'text', data: { text: input.content } }
            : input.content),
          id: 'res_subject',
          role: 'subject',
          authorPrincipalRef: 'p_author',
          createdAt: '2026-07-20T10:00:00.000Z',
          sha256: `sha256:${'a'.repeat(64)}`,
        },
      ],
      relations: [],
      allegations: input.allegations.map((allegation) =>
        typeof allegation === 'string'
          ? { code: allegation, reporterPrincipalRef: 'p_reporter' }
          : { ...allegation, reporterPrincipalRef: 'p_reporter' },
      ),
      policy: { policySetId: 'crowdsource.baseline', version: '2026.07' },
      privacy: { retentionDays: 30, allowCommunityReview: true },
      metadata: input.metadata,
    };

    const parsed = CaseEnvelopeSchema.safeParse(envelope);
    expect(
      parsed.success
        ? []
        : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    ).toEqual([]);
  });

  it('refuses to describe a reported type Mention does not store', async () => {
    const post = await textPost('The reported text.');
    await expect(
      buildModerationReportInput({ ...reportFor(post.id), reportedType: 'message' as const }),
    ).rejects.toThrow(/No moderation subject provider is registered/);
  });

  it('returns null when the reported object is gone', async () => {
    // Nothing seeded — the id names no row.
    expect(
      await buildModerationReportInput(reportFor('019f0000-0000-7000-8000-000000000000')),
    ).toBeNull();
  });

  it('hashes the material and not the report', async () => {
    const post = await textPost('The reported text.');
    const report = reportFor(post.id);

    const byOne = await buildModerationReportInput(report);
    const byAnother = await buildModerationReportInput({
      ...report,
      id: '507f1f77bcf86cd799439099',
      reporter: scope.user('someone-else'),
      categories: ['spam'],
      details: undefined,
    });

    /**
     * Two people reporting the same material must produce the same snapshot hash.
     * The hash identifies the VERSION that was reviewed (§5.6); folding the
     * reporter or the allegations into it would make it a per-report value and
     * useless for recognising that a decision was about an older version of the
     * content.
     */
    expect(byAnother?.snapshotHash).toBe(byOne?.snapshotHash);
  });

  it('hashes DIFFERENTLY once the material itself changes', async () => {
    // The other half of the previous test, and the one that makes it mean
    // something: a hash that ignored the report must still track the CONTENT, or
    // §5.6's "which version was reviewed" is a constant.
    const post = await textPost('The reported text.');
    const beforeEdit = await buildModerationReportInput(reportFor(post.id));

    await replacePostContent(post.id, {
      variants: [{ source: 'author', tag: 'es-ES', text: 'The reported text, edited.' }],
    });

    const afterEdit = await buildModerationReportInput(reportFor(post.id));

    expect(afterEdit?.snapshotHash).not.toBe(beforeEdit?.snapshotHash);
  });
});
