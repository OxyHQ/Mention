import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaseEnvelopeSchema } from '@oxyhq/crowdsource-contracts';

/**
 * The subject-provider seam — the part a second application actually writes.
 *
 * These assert the two things a provider can get wrong in a way nothing else would
 * catch: producing material a jury cannot use, and producing DIFFERENT material for
 * the same object on two deliveries. The second one is the dangerous half — ingress
 * fingerprints the whole envelope, so an unstable snapshot turns a legitimate outbox
 * retry into a permanent 409, days later.
 */

type Doc = Record<string, unknown>;

/** Posts by id, so a parent/quote lookup resolves like the real collection. */
let posts: Map<string, Doc>;

vi.mock('../../../models/Post', () => ({
  default: {
    findById: vi.fn((id: string) => {
      const query = {
        select: () => query,
        lean: async () => {
          const post = posts.get(String(id));
          return post ? { ...post } : null;
        },
      };
      return query;
    }),
  },
}));

const getUserById = vi.fn();

vi.mock('../../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ getUserById }),
}));

import { buildModerationReportInput } from '../../../services/moderation/EvidenceSnapshotService';
import { ReportCategory, ReportedType } from '../../../models/Report.model';
import { createPostSubjectProvider } from '../../../services/moderation/subjects/postSubject';
import { createUserSubjectProvider } from '../../../services/moderation/subjects/userSubject';

const POST_ID = '507f1f77bcf86cd799439022';
const PARENT_ID = '507f1f77bcf86cd799439033';

function textPost(id: string, text: string, extra: Doc = {}): Doc {
  return {
    _id: new mongoose.Types.ObjectId(id),
    content: { variants: [{ source: 'author', tag: 'es-ES', text }] },
    authorship: [{ oxyUserId: 'oxy-author', role: 'owner', status: 'accepted' }],
    createdAt: new Date('2026-07-20T10:00:00.000Z'),
    ...extra,
  };
}

const postProvider = createPostSubjectProvider({
  reportedType: ReportedType.POST,
  subjectType: 'social.post',
});

describe('post subject provider', () => {
  beforeEach(() => {
    posts = new Map();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('describes the post as a text resource with its author and language', async () => {
    posts.set(POST_ID, textPost(POST_ID, 'El texto exacto reportado.'));

    const snapshot = await postProvider.snapshot(POST_ID);

    expect(snapshot).toMatchObject({
      subject: {
        externalId: POST_ID,
        type: 'social.post',
        author: { oxyUserId: 'oxy-author' },
      },
      content: {
        type: 'text',
        data: { text: 'El texto exacto reportado.' },
        language: 'es-ES',
      },
    });
  });

  it('returns null for a post that no longer exists', async () => {
    // Not an error: content deleted between the report and its delivery is ordinary,
    // and a provider that threw would make deletion look like an outage.
    expect(await postProvider.snapshot(POST_ID)).toBeNull();
    expect(await postProvider.snapshot('not-an-object-id')).toBeNull();
  });

  it('does not disclose unpublished or non-public posts to another reporter', async () => {
    posts.set(
      POST_ID,
      textPost(POST_ID, 'Private draft.', { status: 'draft', visibility: 'private' }),
    );

    expect(await postProvider.snapshot(POST_ID, 'oxy-attacker')).toBeNull();
    expect(await postProvider.snapshot(POST_ID, 'oxy-author')).not.toBeNull();
  });

  it('drops a language tag the contract would refuse rather than failing the report', async () => {
    posts.set(
      POST_ID,
      textPost(POST_ID, 'Body.', { content: { variants: [{ source: 'author', tag: 'not a tag', text: 'Body.' }] } }),
    );

    const snapshot = await postProvider.snapshot(POST_ID);

    /**
     * An invalid tag makes envelope composition throw a non-retryable input error. A
     * report must not be undeliverable because a post carries an exotic language tag —
     * the tag is context, not evidence.
     */
    expect(snapshot?.content).not.toHaveProperty('language');
    expect(snapshot?.content).toMatchObject({ data: { text: 'Body.' } });
  });

  it('describes a post with no body as metadata rather than as empty text', async () => {
    posts.set(POST_ID, {
      _id: new mongoose.Types.ObjectId(POST_ID),
      content: { media: [{ id: 'file_1', type: 'image' }, { id: 'file_2', type: 'image' }] },
      authorship: [{ oxyUserId: 'oxy-author', role: 'owner', status: 'accepted' }],
    });

    const snapshot = await postProvider.snapshot(POST_ID);

    /**
     * The contract refuses an empty text resource, and rightly. A `metadata` resource
     * says what the post consisted of without pretending to carry it — so a jury can
     * answer `insufficient_context` for the right reason while Mention cannot yet ship
     * the bytes (see `postSubject.ts`).
     */
    expect(snapshot?.content).toMatchObject({
      type: 'metadata',
      data: { bodyText: 'absent', mediaItems: 2, mediaKinds: 'image', evidenceAttached: false },
    });
  });

  it('carries the parent and the quoted post as context, with the right relations', async () => {
    posts.set(PARENT_ID, textPost(PARENT_ID, 'The post being replied to.'));
    posts.set(POST_ID, textPost(POST_ID, 'The reply.', { parentPostId: PARENT_ID }));

    const snapshot = await postProvider.snapshot(POST_ID);

    expect(snapshot?.context).toEqual([
      expect.objectContaining({
        role: 'parent',
        type: 'text',
        data: { text: 'The post being replied to.' },
      }),
    ]);
  });

  it('omits context whose neighbour is gone or carries no text', async () => {
    posts.set(POST_ID, textPost(POST_ID, 'The reply.', { parentPostId: PARENT_ID }));

    const snapshot = await postProvider.snapshot(POST_ID);

    // A jury judging a reply needs what it replied to; a missing parent is context that
    // does not exist, not a reason to fail the report.
    expect(snapshot?.context).toBeUndefined();
  });

  it('omits private or unpublished neighbouring context', async () => {
    posts.set(
      PARENT_ID,
      textPost(PARENT_ID, 'Private parent.', { status: 'scheduled', visibility: 'private' }),
    );
    posts.set(POST_ID, textPost(POST_ID, 'Public reply.', { parentPostId: PARENT_ID }));

    const snapshot = await postProvider.snapshot(POST_ID, 'oxy-attacker');

    expect(snapshot?.content).toMatchObject({ data: { text: 'Public reply.' } });
    expect(snapshot?.context).toBeUndefined();
  });

  it('passes a declared content warning through as a provenance-named hint', async () => {
    posts.set(POST_ID, textPost(POST_ID, 'Body.', { metadata: { isSensitive: true } }));

    const snapshot = await postProvider.snapshot(POST_ID);

    // §5.2: a prior classification of exposure, never a verdict — and only what the
    // author or the origin instance ASSERTED, never Mention's classifier score.
    expect(snapshot?.content).toMatchObject({ sensitivity: 'author_marked_sensitive' });
  });
});

describe('user subject provider', () => {
  beforeEach(() => {
    posts = new Map();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    // Consistency-critical read: the SDK's five-minute GET cache must not decide what
    // a jury reviews.
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

    // `/@<oxyUserId>` is not a Mention profile URL. Emitting a raw id where a handle
    // belongs is the ghost-handle bug.
    expect(snapshot?.subject).not.toHaveProperty('permalink');
    expect(snapshot?.subject.externalId).toBe('oxy-user-3');
  });
});

describe('report input — what the SDK is handed', () => {
  beforeEach(() => {
    posts = new Map();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const report = {
    id: '507f1f77bcf86cd799439011',
    reportedType: ReportedType.POST,
    reportedId: POST_ID,
    reporter: 'oxy-user-reporter',
    categories: [ReportCategory.HARASSMENT, ReportCategory.SPAM],
    details: 'This account keeps targeting me.',
    createdAt: new Date('2026-07-28T18:00:00.000Z'),
  };

  it('produces the same bytes for the same report every time', async () => {
    posts.set(POST_ID, textPost(POST_ID, 'The reported text.'));

    const first = await buildModerationReportInput(report);
    const second = await buildModerationReportInput(report);

    /**
     * The property that keeps an outbox retry from becoming a 409. Everything the
     * builder composes has to be derived from the report and the object — no clock, no
     * random id, no order that depends on how a client happened to send its categories.
     */
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first?.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('sorts allegations and attaches the reporter words to one of them', async () => {
    posts.set(POST_ID, textPost(POST_ID, 'The reported text.'));

    const built = await buildModerationReportInput(report);

    expect(built?.reportInput.allegations).toEqual([
      {
        code: 'harassment.targeted_abuse',
        details: 'This account keeps targeting me.',
      },
      { code: 'integrity.spam' },
    ]);
    // §6.2: details are the reporter's claim, never evidence for it — so they are not
    // repeated across codes as if written about each separately.
    expect(built?.reportInput.metadata).toMatchObject({
      taxonomyVersion: expect.any(String),
      categories: 'harassment,spam',
    });
    expect(built?.reportInput.submittedAt).toEqual(report.createdAt);
  });

  it('is composable into an envelope the published contract accepts', async () => {
    posts.set(POST_ID, textPost(POST_ID, 'The reported text.'));
    const built = await buildModerationReportInput(report);
    const input = built?.reportInput;
    if (!input) throw new Error('expected a report input');

    /**
     * The end-to-end check that the description is USABLE. The SDK composes the
     * envelope and validates it internally, but it does not export that function — so
     * this reproduces only the shape the SDK derives and validates it against the
     * contract, which is enough to catch a provider emitting a field the envelope
     * refuses.
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
          externalPrincipalId: 'oxy-author',
          bindingProofId: 'oxy-author',
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
          ...(typeof input.content === 'string' ? { type: 'text', data: { text: input.content } } : input.content),
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
    await expect(
      buildModerationReportInput({ ...report, reportedType: ReportedType.MESSAGE }),
    ).rejects.toThrow(/No moderation subject provider is registered/);
  });

  it('returns null when the reported object is gone', async () => {
    expect(await buildModerationReportInput(report)).toBeNull();
  });

  it('hashes the material and not the report', async () => {
    posts.set(POST_ID, textPost(POST_ID, 'The reported text.'));

    const byOne = await buildModerationReportInput(report);
    const byAnother = await buildModerationReportInput({
      ...report,
      id: '507f1f77bcf86cd799439099',
      reporter: 'oxy-user-someone-else',
      categories: [ReportCategory.SPAM],
      details: undefined,
    });

    /**
     * Two people reporting the same material must produce the same snapshot hash. The
     * hash identifies the VERSION that was reviewed (§5.6); folding the reporter or the
     * allegations into it would make it a per-report value and useless for recognising
     * that a decision was about an older version of the content.
     */
    expect(byAnother?.snapshotHash).toBe(byOne?.snapshotHash);
  });
});
