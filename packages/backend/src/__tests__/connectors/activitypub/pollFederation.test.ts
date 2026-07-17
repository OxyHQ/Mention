import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { pollFindByIdLean, pollFindLean } = vi.hoisted(() => ({
  pollFindByIdLean: vi.fn(),
  pollFindLean: vi.fn(),
}));

vi.mock('../../../models/Poll', () => ({
  default: {
    findById: () => ({ select: () => ({ lean: () => pollFindByIdLean() }) }),
    find: () => ({ select: () => ({ lean: () => pollFindLean() }) }),
  },
}));

import type { PostContent } from '@mention/shared-types';
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
    { _id: 'poll1', content, createdAt: ISO },
    'alice',
    undefined,
    undefined,
    poll,
  );
  return activity.object as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
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
      { _id: 'p1', content: body('just a post'), createdAt: ISO },
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

describe('resolvePollContext — reads the linked Poll document', () => {
  it('derives the Question fields and counts UNIQUE voters across options', async () => {
    pollFindByIdLean.mockResolvedValue({
      _id: 'poll1',
      // u2 voted on both options — counted ONCE in votersCount, but each option's
      // own tally still reflects its full vote list.
      options: [
        { text: 'Red', votes: ['u1', 'u2'] },
        { text: 'Blue', votes: ['u2', 'u3', 'u4'] },
      ],
      endsAt: FUTURE,
      isMultipleChoice: true,
    });

    const context = await followService.resolvePollContext({
      _id: 'p1',
      content: { ...body('vote'), pollId: 'poll1' },
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
    pollFindByIdLean.mockResolvedValue({
      _id: 'poll1',
      options: [{ text: 'Yes', votes: [] }],
      endsAt: PAST,
      isMultipleChoice: false,
    });

    const context = await followService.resolvePollContext({
      _id: 'p1',
      content: { ...body('vote'), pollId: 'poll1' },
      createdAt: ISO,
    });

    expect(context?.closed).toBe(true);
    expect(context?.votersCount).toBe(0);
  });

  it('returns null (no DB read) when the post carries no poll', async () => {
    const context = await followService.resolvePollContext({
      _id: 'p1',
      content: body('no poll here'),
      createdAt: ISO,
    });

    expect(context).toBeNull();
    expect(pollFindByIdLean).not.toHaveBeenCalled();
  });
});

describe('resolvePollContextByPost — one batched Poll read for many posts', () => {
  it('keys each poll context by post id and leaves non-poll posts absent', async () => {
    pollFindLean.mockResolvedValue([
      {
        _id: 'pollA',
        options: [{ text: 'A1', votes: ['x'] }],
        endsAt: FUTURE,
        isMultipleChoice: false,
      },
    ]);

    const map = await followService.resolvePollContextByPost([
      { _id: 'p1', content: { ...body('poll post'), pollId: 'pollA' }, createdAt: ISO },
      { _id: 'p2', content: body('plain post'), createdAt: ISO },
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
