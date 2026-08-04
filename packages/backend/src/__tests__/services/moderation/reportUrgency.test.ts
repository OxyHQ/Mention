import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';
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
 *
 * ## Why this file is real rows
 *
 * It arrived from `main` mocking `models/Post`, `models/Report.model` and
 * `models/ModerationOutbox`. Two of those three no longer exist, so the file did
 * not fail an assertion — it failed to LOAD, reporting `Tests: no tests`, and it
 * merged with ZERO conflicts. The feature's only behavioural gate was therefore
 * absent with nothing in the merge output saying so.
 *
 * The posts, the reports and the outbox rows are real now. That is not tidiness:
 * the FREEZE is a property of the stored row (`payload_urgency`, written once and
 * never updated), and a captured `updateOne` argument cannot distinguish a payload
 * that was written from one the database stored differently — which is the whole
 * class of defect this file exists for.
 */

/**
 * Armed by the intake-failure cases so a database failure during the urgency read
 * is exercised through the REAL provider rather than a stubbed one. Deliberately
 * `unknown`: a rejection is under no obligation to be an `Error`, and the two
 * shapes take different paths through the failure handler.
 */
const h = vi.hoisted(() => ({ postLoadFailure: undefined as unknown, getUserById: vi.fn() }));

/**
 * Spread over the REAL repository so only the ONE loader the provider calls can be
 * armed to throw. An enumerated mock would hand every other export back as
 * `undefined` — which is precisely the failure this file was rewritten to stop
 * repeating.
 */
vi.mock('../../../db/posts/postRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../db/posts/postRepository')>();
  return {
    ...actual,
    loadPostRecord: async (...args: Parameters<typeof actual.loadPostRecord>) => {
      if (h.postLoadFailure !== undefined) throw h.postLoadFailure;
      return actual.loadPostRecord(...args);
    },
  };
});

// Oxy is genuinely remote — the only thing here that stays stubbed.
vi.mock('../../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ getUserById: h.getUserById }),
}));

import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { moderationOutbox, reports } from '../../../db/schema/moderation';
import { posts } from '../../../db/schema/posts';
import type { ModerationOutboxPayload } from '../../../db/moderation/moderationOutboxRepository';
import { clearServiceScope, seedPost, serviceScope } from '../../helpers/serviceFixtures';
import { logger } from '../../../utils/logger';
import { createReport } from '../../../services/moderation/ReportIntakeService';
import { buildModerationReportInput } from '../../../services/moderation/EvidenceSnapshotService';
import { createPostSubjectProvider } from '../../../services/moderation/subjects/postSubject';
import { reportSubmitEventId } from '../../../services/moderation/ModerationOutboxService';

const scope = serviceScope('report-urgency');
const SCOPE_PREFIX = `oxy-${scope.name}-`;
const AUTHOR = scope.user('author');
const REPORTER = scope.user('reporter');

/**
 * The registry is NOT mocked here, unlike in the durability tests.
 *
 * The property under test spans intake, the outbox row and the builder, and the
 * interesting half of it lives inside Mention's own post provider — a stubbed
 * provider would assert that the plumbing carries whatever it is given, which is
 * the part that was never in doubt.
 */
const postProvider = createPostSubjectProvider({
  reportedType: 'post',
  subjectType: 'social.post',
});

/** A published public post owned by {@link AUTHOR}, with a chosen view count. */
async function seedSubject(
  options: { views?: number; overrides?: Parameters<typeof seedPost>[1] } = {},
): Promise<string> {
  const record = await seedPost(scope, {
    oxyUserId: AUTHOR,
    createdAt: new Date('2026-07-20T10:00:00.000Z'),
    content: { variants: [{ source: 'author', tag: 'en', text: 'The reported text.' }] },
    ...options.overrides,
  });
  // `stats_views_count` is `integer NOT NULL DEFAULT 0` and `PostRecordInput` does
  // not accept it, so the counter is set on the row afterwards — the same way the
  // channel-writer fixtures set `created_at`.
  if (options.views !== undefined) {
    await getDb()
      .update(posts)
      .set({ statsViewsCount: options.views })
      .where(eq(posts.id, record.id));
  }
  return record.id;
}

/** Take a report through the REAL intake and return the payload it enqueued. */
async function intake(input: {
  reportedType: 'post' | 'user';
  reportedId: string;
  reporter?: string;
}): Promise<ModerationOutboxPayload> {
  const result = await createReport({
    reporter: input.reporter ?? REPORTER,
    reportedType: input.reportedType,
    reportedId: input.reportedId,
    categories: ['harassment'],
  });

  const [row] = await getDb()
    .select({
      payloadReportId: moderationOutbox.payloadReportId,
      payloadUrgency: moderationOutbox.payloadUrgency,
    })
    .from(moderationOutbox)
    .where(eq(moderationOutbox.id, reportSubmitEventId(result.report.id)))
    .limit(1);

  // Reassembled the way `toPayload` does, so an absent urgency is an ABSENT KEY
  // rather than a `null` — the distinction the strict contract turns on.
  return {
    ...(row?.payloadReportId == null ? {} : { reportId: row.payloadReportId }),
    ...(row?.payloadUrgency == null ? {} : { urgency: row.payloadUrgency }),
  };
}

/** The report row as the delivery worker reconstructs it. */
function reportRow(reportedId: string, reporter = REPORTER) {
  return {
    id: 'report-under-test',
    reportedType: 'post' as const,
    reportedId,
    reporter,
    categories: ['harassment' as const],
    details: null,
    createdAt: new Date('2026-07-28T18:00:00.000Z'),
  };
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  h.postLoadFailure = undefined;
  vi.clearAllMocks();
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await getDb().delete(reports).where(like(reports.reporter, `${SCOPE_PREFIX}%`));
  await getDb().delete(reports).where(like(reports.reportedId, `${SCOPE_PREFIX}%`));
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('report urgency — what reaches triage', () => {
  it('gives a widely-distributed post a higher reach than an unseen one', async () => {
    const seenId = await seedSubject({ views: 250_000 });
    const unseenId = await seedSubject({ views: 3 });

    const seen = await intake({ reportedType: 'post', reportedId: seenId });
    const unseen = await intake({ reportedType: 'post', reportedId: unseenId });

    const widely = await buildModerationReportInput(reportRow(seenId), seen.urgency);
    const barely = await buildModerationReportInput(reportRow(unseenId), unseen.urgency);

    /**
     * The whole point of the field: without it both of these arrive at `reach: 0`
     * and the queue orders them by nothing. `reach` is CrowdSource's own "how many
     * people the material reached, as the application counts it", and Mention
     * counts it with the deduplicated per-viewer feed impression counter.
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

  const DISTRIBUTION_CASES: ReadonlyArray<
    [string, Parameters<typeof seedPost>[1], string, boolean]
  > = [
    ['a public published post', {}, 'public_feed', true],
    [
      'a post whose audience the author limited',
      { visibility: 'followers_only' },
      'limited_audience',
      false,
    ],
    ['a post an earlier decision restricted', { status: 'restricted' }, 'not_distributed', false],
    [
      'a copy of material published on another instance',
      { federation: { url: 'https://remote.example/@a/1', sensitive: false } },
      'federated_origin',
      true,
    ],
  ];

  it.each(DISTRIBUTION_CASES)(
    'describes %s as distribution, not as severity',
    async (_case, overrides, hint, active) => {
      const id = await seedSubject({ views: 7, overrides });

      /**
       * Reported by the AUTHOR, because the disclosure gate withholds a non-public
       * post from anybody else — urgency and material load through the same gate on
       * purpose, so a report can never describe the distribution of content the
       * envelope will not carry.
       */
      const urgency = await postProvider.urgencySnapshot?.(id, AUTHOR);

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
    const id = await seedSubject({ views: 12 });

    // Self-report, so the disclosure gate keeps returning the post after the
    // visibility flip below and the two builds stay comparable.
    const payload = await intake({ reportedType: 'post', reportedId: id, reporter: AUTHOR });
    const first = await buildModerationReportInput(reportRow(id, AUTHOR), payload.urgency);

    // The post goes viral and its author narrows the audience — all three urgency
    // fields would change under a live read.
    await getDb()
      .update(posts)
      .set({ statsViewsCount: 900_000, visibility: 'followers_only' })
      .where(eq(posts.id, id));

    /**
     * The positive control, and it is not optional. Without it this file passes
     * against an implementation that never reads distribution at all, because
     * "unchanged" and "never present" are indistinguishable in the assertion below.
     * This proves the mutation is one a delivery-time read WOULD see.
     */
    expect(await postProvider.urgencySnapshot?.(id, AUTHOR)).toEqual({
      hint: 'limited_audience',
      reach: 900_000,
      activeDistribution: false,
    });

    const second = await buildModerationReportInput(reportRow(id, AUTHOR), payload.urgency);

    /**
     * The property that keeps an outbox retry from becoming a permanent 409:
     * ingress fingerprints the whole `{ externalReportId, envelope }`, so a second
     * attempt that composes different bytes is §10.5's payload conflict rather than
     * a redelivery. Asserted on the serialised form because that is what is hashed
     * — a field that merely compared equal but serialised differently would fail
     * there and pass a `toEqual`.
     */
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first?.reportInput.urgency).toEqual({
      hint: 'public_feed',
      reach: 12,
      activeDistribution: true,
    });
  });

  it('writes the urgency onto the outbox row, where nothing updates it', async () => {
    const id = await seedSubject({ views: 41 });

    const payload = await intake({ reportedType: 'post', reportedId: id });

    /**
     * The freeze is the ROW, not a convention. `enqueueModerationOutboxEvent`
     * inserts with `ON CONFLICT DO NOTHING`, so a repeat enqueue for this
     * deterministic event id cannot overwrite the value with a later reading of the
     * same post — asserted here as the stored column, and as a no-op replay in
     * `db/moderationOutboxRepository.test.ts`.
     */
    expect(payload).toEqual({
      reportId: expect.any(String),
      urgency: { hint: 'public_feed', reach: 41, activeDistribution: true },
    });
  });
});

describe('report urgency — an absence is not a zero', () => {
  /**
   * ONE fixture, where `main` had three, and the reason is a real difference
   * between the two stores rather than a trimmed test.
   *
   * Its `it.each` also covered a FRACTIONAL counter (`12.5`) and a NON-NUMERIC one
   * (`'900'`). Neither is representable here, and the reach of that claim was
   * MEASURED rather than assumed: `reachedAudience` has exactly one production
   * caller (`urgencySnapshot`), whose post comes only from `loadPost` ->
   * `loadPostRecord`, which assembles `stats.viewsCount` from
   * `posts.stats_views_count` — `integer NOT NULL`. There is no hydrated DTO, no
   * cache and no external payload feeding it, so the column is the SOLE writer and
   * Postgres coerces or refuses both shapes before the guard is ever reached.
   *
   * They are dropped rather than injected with raw SQL on purpose. Bypassing the
   * column to store `12.5` would test whether Postgres enforces `integer` — a
   * guarantee Postgres already makes — wearing the costume of a test of our code,
   * and it would pass forever regardless of what the guard does. A fixture that
   * cannot express its own claim is worse than no fixture: it reads as coverage.
   *
   * The guard KEEPS both halves anyway, and this is the sentence that should stop
   * anyone deleting them next year on the grounds that nothing tests them: they are
   * unreachable through the only writer that exists today, and the guard remains
   * because a future writer may not be the column.
   *
   * A NEGATIVE counter IS still representable — the column carries no CHECK — so
   * that half of the guard keeps a real fixture. Note the app's own increment path
   * clamps (`greatest(0, stats_views_count + delta)`), so this too is a value no
   * current writer produces; it is reachable by direct write, which is exactly what
   * the fixture below does.
   */
  it('omits reach rather than coercing a negative counter', async () => {
    const id = await seedSubject({ views: -1 });

    const urgency = await postProvider.urgencySnapshot?.(id, AUTHOR);

    /**
     * The contract refuses anything but a non-negative integer, and a refused
     * envelope is a NON-retryable input error — so a corrupt counter rounded or
     * clamped into shape would cost the whole report, not just its queue position.
     */
    expect(urgency).not.toHaveProperty('reach');
    expect(CaseUrgencySchema.safeParse(urgency).success).toBe(true);
  });

  it('sends no urgency at all for a subject with no defensible audience', async () => {
    h.getUserById.mockResolvedValue({ username: 'reported_account', name: {} });
    const subject = scope.user('reported-account');

    const payload = await intake({ reportedType: 'user', reportedId: subject });

    /**
     * A profile has no audience figure Mention holds — the follower count answers a
     * different question (who subscribed to the account, not who read the bio under
     * review). `urgency` is optional exactly so an application can decline rather
     * than invent, so the field is absent on the outbox row and never reaches the
     * envelope.
     */
    expect(payload).toEqual({ reportId: expect.any(String) });
    expect(payload).not.toHaveProperty('urgency');
  });

  it('sends no urgency for material whose distribution cannot be described', async () => {
    // The post is gone between the report and this read, so the provider answers
    // `null` — distinct from throwing, and distinct from "this noun has no reach".
    const missing = `${SCOPE_PREFIX}post-that-never-existed`;

    const payload = await intake({ reportedType: 'post', reportedId: missing });

    expect(payload).toEqual({ reportId: expect.any(String) });
    expect(payload).not.toHaveProperty('urgency');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  const INTAKE_FAILURES: ReadonlyArray<[string, unknown, string]> = [
    ['an Error', new Error('connection to postgres lost'), 'connection to postgres lost'],
    // A rejection is under no obligation to be an `Error`. The handler stringifies
    // whatever it caught, because a failure nobody can read is the one thing worse
    // than a failure.
    ['something that is not an Error', 'ECONNRESET', 'ECONNRESET'],
  ];

  it.each(INTAKE_FAILURES)(
    'still takes the report when composing urgency throws %s',
    async (_case, thrown, expectedMessage) => {
      const id = await seedSubject({ views: 5 });
      h.postLoadFailure = thrown;

      const payload = await intake({ reportedType: 'post', reportedId: id });

      /**
       * The priority of the two things at stake. A missing urgency costs the case up
       * to ten of a hundred triage points; a raised one costs the reporter their
       * report entirely, because `createReport` is what `POST /reports` awaits. So
       * the failure is swallowed for the URGENCY and never for the report — the
       * outbox row is still written, and the report will still be delivered.
       */
      expect(payload).toEqual({ reportId: expect.any(String) });
      expect(payload).not.toHaveProperty('urgency');

      // The REPORT survived, asserted as a stored ROW rather than as a call on a
      // mock — the whole reason this file moved onto real rows.
      const stored = await getDb()
        .select({ id: reports.id })
        .from(reports)
        .where(eq(reports.reportedId, id));
      expect(stored).toHaveLength(1);

      // Swallowed is not the same as silent: the reason has to reach an operator,
      // or a permanently mis-triaged queue has no explanation anywhere.
      expect(logger.warn).toHaveBeenCalledWith(
        '[CrowdSource] could not snapshot report urgency',
        expect.objectContaining({ reportedId: id, error: expectedMessage }),
      );
    },
  );

  it('drops a stored urgency the contract refuses instead of losing the report', async () => {
    const id = await seedSubject({ views: 5 });

    const built = await buildModerationReportInput(reportRow(id), {
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
    expect(built?.reportInput.subject.externalId).toBe(id);
  });
});
