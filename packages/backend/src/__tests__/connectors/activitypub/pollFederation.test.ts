import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';

/**
 * Outbound POLL federation: a post that carries a poll federates as an
 * ActivityPub `Question` instead of a `Note`. These pin two things:
 *
 *  1. the PURE builder (`buildCreateNoteActivity` with a resolved poll context):
 *     a single-choice poll → `oneOf`, a multiple-choice poll → `anyOf`, each
 *     option a `Note` whose `replies.totalItems` is that option's vote count;
 *     `endTime` while open / `closed` once ended; `votersCount` (unique voters);
 *     and that the SHARED object fields (attributedTo/content/url/…) are inherited
 *     unchanged, so a non-poll post still emits a plain `Note`.
 *  2. the DB-read resolver (`resolvePollContext` / `resolvePollContextByPost`):
 *     it reads the linked `Poll` document and derives those fields, counting
 *     UNIQUE voters across options.
 *
 * The builder's transitive deps are stubbed so `FollowService` imports in
 * isolation; the `Poll` model is stubbed with controllable lean output.
 */

vi.mock('../../../connectors/activitypub/actor.service', () => ({ actorService: {} }));
vi.mock('../../../connectors/activitypub/crypto', () => ({ getPublicKey: vi.fn(), signRequest: vi.fn() }));
vi.mock('../../../queue/producers', () => ({ enqueueDelivery: vi.fn(), enqueueInboxActivity: vi.fn() }));
vi.mock('../../../models/FederatedActor', () => ({ default: {} }));
vi.mock('../../../models/FederatedFollow', () => ({ default: {} }));
vi.mock('../../../models/FederationDeliveryQueue', () => ({ default: {} }));
vi.mock('../../../utils/safeUpstreamFetch', () => ({ fetchUpstreamSingleHop: vi.fn() }));
vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  assertSafePublicUrl: vi.fn(),
}));
vi.mock('../../../utils/mediaResolver', () => ({
  resolveMediaRef: (ref: string) => ({ url: `https://cloud.oxy.so/${ref}` }),
}));

const { pollFindLean } = vi.hoisted(() => ({
}));


import type { PostContent } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { pollOptions, pollVotes, polls } from '../../../db/schema/polls';
import { followService, type NotePollContext } from '../../../connectors/activitypub/follow.service';

const ISO = '2024-01-02T03:04:05.000Z';
const FUTURE = new Date('2099-01-01T00:00:00.000Z');
const PAST = new Date('2000-01-01T00:00:00.000Z');

function body(text: string): PostContent {
  return { variants: [{ source: 'author', text }] };
}

/** Build the Question `object` for a post carrying the given resolved poll context. */
function questionFor(poll: NotePollContext, content: PostContent = body('vote now')) {
  const activity = followService.buildCreateNoteActivity(
    { id: 'poll1', content, createdAt: ISO },
    'alice',
    undefined,
    undefined,
    poll,
  );
  return activity.object as Record<string, unknown>;
}

/**
 * A REAL poll: one `polls` row, its options as ordered `poll_options` rows, and
 * each ballot as a `poll_votes` row.
 *
 * The resolver used to read the Mongoose `Poll` model, which nothing has written
 * since polls moved to Postgres — so it resolved null for every poll and every
 * poll post federated as a plain Note. That is invisible from the outside: null
 * is also how "this post has no poll" is spelled.
 */
async function seedPoll(options: {
  choices: Array<{ text: string; voters: string[] }>;
  endsAt: Date;
  multiple?: boolean;
}): Promise<string> {
  const db = getDb();
  const [poll] = await db
    .insert(polls)
    .values({
      question: 'q',
      createdBy: `oxy-poll-fed-${randomUUID()}`,
      endsAt: options.endsAt,
      isMultipleChoice: options.multiple ?? false,
    })
    .returning({ id: polls.id });
  createdPollIds.push(poll.id);

  for (const [position, choice] of options.choices.entries()) {
    const [option] = await db
      .insert(pollOptions)
      .values({ pollId: poll.id, position, text: choice.text })
      .returning({ id: pollOptions.id });
    for (const voter of choice.voters) {
      await db.insert(pollVotes).values({ pollId: poll.id, optionId: option.id, userId: voter });
    }
  }
  return poll.id;
}

const createdPollIds: string[] = [];

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  const ids = createdPollIds.splice(0);
  // `poll_options` / `poll_votes` cascade from the poll row.
  if (ids.length > 0) await getDb().delete(polls).where(inArray(polls.id, ids));
});

afterAll(async () => {
  await closePostgres();
});

describe('buildCreateNoteActivity — poll → Question', () => {
  it('emits a single-choice Question with oneOf, per-option replies.totalItems, endTime (open) and votersCount', () => {
    const object = questionFor({
      multiple: false,
      options: [
        { name: 'Red', votes: 3 },
        { name: 'Blue', votes: 5 },
      ],
      endTime: FUTURE,
      closed: false,
      votersCount: 8,
    });

    expect(object.type).toBe('Question');
    expect(object.oneOf).toEqual([
      { type: 'Note', name: 'Red', replies: { type: 'Collection', totalItems: 3 } },
      { type: 'Note', name: 'Blue', replies: { type: 'Collection', totalItems: 5 } },
    ]);
    expect(object.anyOf).toBeUndefined();
    // Open poll → endTime present, closed absent.
    expect(object.endTime).toBe(FUTURE.toISOString());
    expect(object.closed).toBeUndefined();
    expect(object.votersCount).toBe(8);

    // The SHARED object fields are inherited unchanged from the Note assembly.
    expect(object.attributedTo).toBe('https://mention.earth/ap/users/alice');
    expect(object.id).toBe('https://mention.earth/ap/users/alice/posts/poll1');
    expect(object.url).toBe('https://mention.earth/@alice/posts/poll1');
    expect(object.content).toBe('<p>vote now</p>');
  });

  it('emits a multiple-choice Question with anyOf (not oneOf)', () => {
    const object = questionFor({
      multiple: true,
      options: [
        { name: 'A', votes: 1 },
        { name: 'B', votes: 2 },
      ],
      endTime: FUTURE,
      closed: false,
      votersCount: 2,
    });

    expect(object.type).toBe('Question');
    expect(object.anyOf).toEqual([
      { type: 'Note', name: 'A', replies: { type: 'Collection', totalItems: 1 } },
      { type: 'Note', name: 'B', replies: { type: 'Collection', totalItems: 2 } },
    ]);
    expect(object.oneOf).toBeUndefined();
  });

  it('emits `closed` (not `endTime`) once the poll has ended', () => {
    const object = questionFor({
      multiple: false,
      options: [{ name: 'Yes', votes: 7 }],
      endTime: PAST,
      closed: true,
      votersCount: 7,
    });

    expect(object.closed).toBe(PAST.toISOString());
    expect(object.endTime).toBeUndefined();
  });

  it('a non-poll post still emits a plain Note (no poll fields)', () => {
    const activity = followService.buildCreateNoteActivity(
      { id: 'p1', content: body('just a post'), createdAt: ISO },
      'alice',
    );
    const object = activity.object as Record<string, unknown>;

    expect(object.type).toBe('Note');
    expect(object.oneOf).toBeUndefined();
    expect(object.anyOf).toBeUndefined();
    expect(object.votersCount).toBeUndefined();
    expect(object.endTime).toBeUndefined();
    expect(object.closed).toBeUndefined();
  });
});

describe('resolvePollContext — reads the linked poll rows', () => {
  it('derives the Question fields and counts UNIQUE voters across options', async () => {
    // u2 voted on both options — counted ONCE in votersCount, while each
    // option's own tally still reflects its full ballot list.
    const pollId = await seedPoll({
      choices: [
        { text: 'Red', voters: ['u1', 'u2'] },
        { text: 'Blue', voters: ['u2', 'u3', 'u4'] },
      ],
      endsAt: FUTURE,
      multiple: true,
    });

    const context = await followService.resolvePollContext({
      id: 'p1',
      content: { ...body('vote'), pollId },
      createdAt: ISO,
    });

    expect(context).toEqual({
      multiple: true,
      options: [
        { name: 'Red', votes: 2 },
        { name: 'Blue', votes: 3 },
      ],
      endTime: FUTURE,
      closed: false,
      votersCount: 4,
    });
  });

  it('marks a poll whose deadline has passed as closed', async () => {
    const pollId = await seedPoll({
      choices: [{ text: 'Yes', voters: [] }],
      endsAt: PAST,
    });

    const context = await followService.resolvePollContext({
      id: 'p1',
      content: { ...body('vote'), pollId },
      createdAt: ISO,
    });

    expect(context?.closed).toBe(true);
    expect(context?.votersCount).toBe(0);
  });

  it('returns null when the post carries no poll', async () => {
    const context = await followService.resolvePollContext({
      id: 'p1',
      content: body('no poll here'),
      createdAt: ISO,
    });

    expect(context).toBeNull();
  });

  it('returns null when the linked poll is gone (fail-soft)', async () => {
    const context = await followService.resolvePollContext({
      id: 'p1',
      content: { ...body('vote'), pollId: '019fffff-ffff-7fff-bfff-ffffffffffff' },
      createdAt: ISO,
    });

    expect(context).toBeNull();
  });
});

describe('resolvePollContextByPost — one batched read for many posts', () => {
  it('keys each poll context by post id and leaves non-poll posts absent', async () => {
    const pollId = await seedPoll({
      choices: [{ text: 'A1', voters: ['x'] }],
      endsAt: FUTURE,
    });

    const map = await followService.resolvePollContextByPost([
      { id: 'p1', content: { ...body('poll post'), pollId }, createdAt: ISO },
      { id: 'p2', content: body('plain post'), createdAt: ISO },
    ]);

    expect(map.get('p1')).toEqual({
      multiple: false,
      options: [{ name: 'A1', votes: 1 }],
      endTime: FUTURE,
      closed: false,
      votersCount: 1,
    });
    expect(map.has('p2')).toBe(false);
  });
});
