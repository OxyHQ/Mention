import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaseUrgencySchema } from '@oxyhq/crowdsource-contracts';

/**
 * §5.1 `urgency` — the distribution facts that decide QUEUE ORDER.
 *
 * Two properties are under test and they pull in opposite directions, which is why
 * they live in one file: the value has to DISCRIMINATE (a post thousands of people
 * saw must not queue behind one nobody has seen) and it has to be FROZEN (the same
 * report delivered twice must compose the same bytes, because the ingress
 * fingerprints the envelope and a changed one is a permanent 409 rather than a new
 * case).
 *
 * A live read at delivery satisfies the first and destroys the second, silently,
 * and the damage surfaces days later as moderation work stuck in a queue. So the
 * frozen-value test below mutates the post between two builds and pins the result
 * — and proves the mutation is one a live read WOULD see, or it would pass against
 * an implementation with no snapshot in it at all.
 */

type Doc = Record<string, unknown>;

/** Posts by id, so the real provider's own loader resolves them. */
let posts: Map<string, Doc>;
/** Every `payload` handed to the outbox, in order. */
let enqueuedPayloads: Doc[];

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

vi.mock('../../../models/Report.model', async () => {
  const actual = await vi.importActual<typeof import('../../../models/Report.model')>(
    '../../../models/Report.model',
  );
  return {
    ...actual,
    default: {
      findOne: vi.fn(),
      create: vi.fn(),
    },
  };
});

vi.mock('../../../models/ModerationOutbox', () => ({
  MODERATION_OUTBOX_RETENTION_SECONDS: 90 * 24 * 60 * 60,
  default: {
    updateOne: vi.fn(async (_filter: Doc, update: Doc) => {
      const setOnInsert = (update.$setOnInsert as Doc | undefined) ?? {};
      enqueuedPayloads.push((setOnInsert.payload as Doc | undefined) ?? {});
      return { matchedCount: 1, modifiedCount: 1 };
    }),
  },
}));

const getUserById = vi.fn();

vi.mock('../../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ getUserById }),
}));

import ModerationOutbox from '../../../models/ModerationOutbox';
import Report, { ReportCategory, ReportedType } from '../../../models/Report.model';
import { createReport } from '../../../services/moderation/ReportIntakeService';
import { buildModerationReportInput } from '../../../services/moderation/EvidenceSnapshotService';
import { createPostSubjectProvider } from '../../../services/moderation/subjects/postSubject';

const REPORT_ID = '507f1f77bcf86cd799439011';
const POST_ID = '507f1f77bcf86cd799439022';
const OTHER_POST_ID = '507f1f77bcf86cd799439033';
const AUTHOR = 'oxy-author';
const REPORTER = 'oxy-user-reporter';

/**
 * The registry is NOT mocked here, unlike in the durability tests.
 *
 * The property under test spans intake, the outbox payload and the builder, and
 * the interesting half of it lives inside Mention's own post provider — a stubbed
 * provider would assert that the plumbing carries whatever it is given, which is
 * the part that was never in doubt.
 */
const postProvider = createPostSubjectProvider({
  reportedType: ReportedType.POST,
  subjectType: 'social.post',
});

function post(id: string, extra: Doc = {}): Doc {
  return {
    _id: new mongoose.Types.ObjectId(id),
    content: { variants: [{ source: 'author', tag: 'en', text: 'The reported text.' }] },
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    createdAt: new Date('2026-07-20T10:00:00.000Z'),
    status: 'published',
    visibility: 'public',
    ...extra,
  };
}

/** A session that reports being inside a transaction, as the enqueue guard requires. */
function stubSession(): void {
  vi.spyOn(mongoose, 'startSession').mockResolvedValue({
    inTransaction: () => true,
    withTransaction: vi.fn(async (operation: () => Promise<void>) => {
      await operation();
    }),
    endSession: vi.fn().mockResolvedValue(undefined),
  } as never);
}

/** Take a report through the real intake and return the payload it enqueued. */
async function intake(input: {
  reportedType: ReportedType;
  reportedId: string;
  reporter?: string;
}): Promise<Doc> {
  stubSession();
  vi.mocked(Report.findOne).mockReturnValue({
    session: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(null),
  } as never);
  vi.mocked(Report.create).mockResolvedValue([
    { _id: new mongoose.Types.ObjectId(REPORT_ID), id: REPORT_ID },
  ] as never);

  const before = enqueuedPayloads.length;
  await createReport({
    reporter: input.reporter ?? REPORTER,
    reportedType: input.reportedType,
    reportedId: input.reportedId,
    categories: [ReportCategory.HARASSMENT],
  });
  return enqueuedPayloads[before] ?? {};
}

/** The report row as the delivery worker reconstructs it. */
function reportRow(reportedId = POST_ID, reporter = REPORTER) {
  return {
    id: REPORT_ID,
    reportedType: ReportedType.POST,
    reportedId,
    reporter,
    categories: [ReportCategory.HARASSMENT],
    details: undefined,
    createdAt: new Date('2026-07-28T18:00:00.000Z'),
  };
}

beforeEach(() => {
  posts = new Map();
  enqueuedPayloads = [];
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('report urgency — what reaches triage', () => {
  it('gives a widely-distributed post a higher reach than an unseen one', async () => {
    posts.set(POST_ID, post(POST_ID, { stats: { viewsCount: 250_000 } }));
    posts.set(OTHER_POST_ID, post(OTHER_POST_ID, { stats: { viewsCount: 3 } }));

    const seen = await intake({ reportedType: ReportedType.POST, reportedId: POST_ID });
    const unseen = await intake({
      reportedType: ReportedType.POST,
      reportedId: OTHER_POST_ID,
    });

    const widely = await buildModerationReportInput(reportRow(POST_ID), seen.urgency);
    const barely = await buildModerationReportInput(
      reportRow(OTHER_POST_ID),
      unseen.urgency,
    );

    /**
     * The whole point of the field: without it both of these arrive at `reach: 0`
     * and the queue orders them by nothing. `reach` is CrowdSource's own
     * "how many people the material reached, as the application counts it", and
     * Mention counts it with the deduplicated per-viewer feed impression counter.
     */
    expect(widely?.reportInput.urgency).toEqual({
      hint: 'public_feed',
      reach: 250_000,
      activeDistribution: true,
    });
    expect(barely?.reportInput.urgency).toEqual({
      hint: 'public_feed',
      reach: 3,
      activeDistribution: true,
    });
  });

  const DISTRIBUTION_CASES: ReadonlyArray<[string, Doc, string, boolean]> = [
    ['a public published post', {}, 'public_feed', true],
    [
      'a post whose audience the author limited',
      { visibility: 'followers' },
      'limited_audience',
      false,
    ],
    [
      'a post an earlier decision restricted',
      { status: 'restricted' },
      'not_distributed',
      false,
    ],
    [
      'a copy of material published on another instance',
      { federation: { url: 'https://remote.example/@a/1', sensitive: false } },
      'federated_origin',
      true,
    ],
  ];

  it.each(DISTRIBUTION_CASES)(
    'describes %s as distribution, not as severity',
    async (_case, extra, hint, active) => {
      posts.set(POST_ID, post(POST_ID, { stats: { viewsCount: 7 }, ...extra }));

      /**
       * Reported by the AUTHOR, because the disclosure gate withholds a non-public
       * post from anybody else — urgency and material load through the same gate on
       * purpose, so a report can never describe the distribution of content the
       * envelope will not carry.
       */
      const urgency = await postProvider.urgencySnapshot?.(POST_ID, AUTHOR);

      expect(urgency).toEqual({ hint, reach: 7, activeDistribution: active });
      /**
       * §7.4 decides queue order and explicitly does not decide guilt, so every
       * token has to be a fact about where the post is readable. The contract's own
       * schema is the gate on the token's SHAPE; naming the four states here is the
       * gate on its MEANING — a hint that started describing the allegation would
       * still be a perfectly valid lowercase token.
       */
      expect(CaseUrgencySchema.safeParse(urgency).success).toBe(true);
    },
  );
});

describe('report urgency — frozen at intake', () => {
  it('composes the same bytes twice even after the post moves underneath it', async () => {
    posts.set(
      POST_ID,
      post(POST_ID, { stats: { viewsCount: 12 }, visibility: 'public' }),
    );

    // Self-report, so the disclosure gate keeps returning the post after the
    // visibility flip below and the two builds stay comparable.
    const payload = await intake({
      reportedType: ReportedType.POST,
      reportedId: POST_ID,
      reporter: AUTHOR,
    });
    const first = await buildModerationReportInput(
      reportRow(POST_ID, AUTHOR),
      payload.urgency,
    );

    // The post goes viral and its author narrows the audience — all three urgency
    // fields would change under a live read.
    posts.set(
      POST_ID,
      post(POST_ID, { stats: { viewsCount: 900_000 }, visibility: 'followers' }),
    );

    /**
     * The positive control, and it is not optional. Without it this file passes
     * against an implementation that never reads distribution at all, because
     * "unchanged" and "never present" are indistinguishable in the assertion
     * below. This proves the mutation is one a delivery-time read WOULD see.
     */
    expect(await postProvider.urgencySnapshot?.(POST_ID, AUTHOR)).toEqual({
      hint: 'limited_audience',
      reach: 900_000,
      activeDistribution: false,
    });

    const second = await buildModerationReportInput(
      reportRow(POST_ID, AUTHOR),
      payload.urgency,
    );

    /**
     * The property that keeps an outbox retry from becoming a permanent 409:
     * ingress fingerprints the whole `{ externalReportId, envelope }`, so a second
     * attempt that composes different bytes is §10.5's payload conflict rather
     * than a redelivery. Asserted on the serialised form because that is what is
     * hashed — a field that merely compared equal but serialised differently would
     * fail there and pass a `toEqual`.
     */
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first?.reportInput.urgency).toEqual({
      hint: 'public_feed',
      reach: 12,
      activeDistribution: true,
    });
  });

  it('writes the urgency onto the outbox row, where nothing updates it', async () => {
    posts.set(POST_ID, post(POST_ID, { stats: { viewsCount: 41 } }));

    const payload = await intake({ reportedType: ReportedType.POST, reportedId: POST_ID });

    /**
     * The freeze is the row, not a convention. `enqueueModerationOutboxEvent`
     * writes only inside `$setOnInsert`, so a repeat enqueue for this deterministic
     * event id cannot overwrite the value with a later reading of the same post.
     */
    expect(payload).toEqual({
      reportId: REPORT_ID,
      urgency: { hint: 'public_feed', reach: 41, activeDistribution: true },
    });
    const [, update] = vi.mocked(ModerationOutbox.updateOne).mock.calls[0];
    expect(update).toEqual(
      expect.objectContaining({ $setOnInsert: expect.objectContaining({ payload }) }),
    );
    expect(update).not.toHaveProperty('$set');
  });
});

describe('report urgency — an absence is not a zero', () => {
  it('omits reach for a post Mention has no view count for', async () => {
    // A federated post backfilled from an outbox has no `stats` subdoc at all.
    posts.set(POST_ID, post(POST_ID));

    const payload = await intake({ reportedType: ReportedType.POST, reportedId: POST_ID });
    const built = await buildModerationReportInput(reportRow(), payload.urgency);

    /**
     * `reach: 0` is a claim that nobody saw it. An absent counter is "Mention
     * cannot say", and the two are different sentences even though triage scores
     * them identically today — `log10(1 + 0)` is 0. Sending the claim would make
     * this code responsible for an assertion it cannot support the moment that
     * weighting changes.
     */
    expect(built?.reportInput.urgency).toEqual({
      hint: 'public_feed',
      activeDistribution: true,
    });
    expect(built?.reportInput.urgency).not.toHaveProperty('reach');
  });

  const CORRUPT_COUNTERS: ReadonlyArray<[string, Doc]> = [
    ['a fractional counter', { viewsCount: 12.5 }],
    ['a negative counter', { viewsCount: -1 }],
    ['a counter that is not a number', { viewsCount: '900' }],
  ];

  it.each(CORRUPT_COUNTERS)('omits reach rather than coercing %s', async (_case, stats) => {
    posts.set(POST_ID, post(POST_ID, { stats }));

    const urgency = await postProvider.urgencySnapshot?.(POST_ID);

    /**
     * The contract refuses anything but a non-negative integer, and a refused
     * envelope is a NON-retryable input error — so a corrupt counter rounded or
     * clamped into shape would cost the whole report, not just its queue position.
     */
    expect(urgency).not.toHaveProperty('reach');
    expect(CaseUrgencySchema.safeParse(urgency).success).toBe(true);
  });

  it('sends no urgency at all for a subject with no defensible audience', async () => {
    getUserById.mockResolvedValue({ username: 'reported_account', name: {} });

    const payload = await intake({
      reportedType: ReportedType.USER,
      reportedId: 'oxy-user-9',
    });
    const built = await buildModerationReportInput(
      { ...reportRow(), reportedType: ReportedType.USER, reportedId: 'oxy-user-9' },
      payload.urgency,
    );

    /**
     * A profile has no audience figure Mention holds — the follower count answers
     * a different question (who subscribed to the account, not who read the bio
     * under review). `urgency` is optional exactly so an application can decline
     * rather than invent, so the field is absent end to end: off the outbox row and
     * off the report input.
     */
    expect(payload).toEqual({ reportId: REPORT_ID });
    expect(built?.reportInput).not.toHaveProperty('urgency');
  });

  it('drops a stored urgency the contract refuses instead of losing the report', async () => {
    posts.set(POST_ID, post(POST_ID, { stats: { viewsCount: 5 } }));

    const built = await buildModerationReportInput(reportRow(), {
      hint: 'public_feed',
      reach: 5,
      unknownKey: 'from a newer deployment',
    });

    /**
     * `CaseUrgencySchema` is a STRICT object, so an extra key is a validation
     * failure — and `CrowdSourceReportInputError` carries `retryable: false`, which
     * dead-letters the event. A report must not be lost because a scheduling hint
     * was written by a deployment this one does not understand, so the value is
     * dropped and the report still goes.
     */
    expect(built?.reportInput).not.toHaveProperty('urgency');
    expect(built?.reportInput.subject.externalId).toBe(POST_ID);
  });
});
