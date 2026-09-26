import type { HydratedPost } from '@mention/shared-types';
import type { Draft } from '../useDrafts';

// The merge is a pure function; the two hooks it sits between (device storage
// and the React Query cache) are not what this file is about.
jest.mock('@/hooks/useDrafts', () => ({ useDrafts: jest.fn() }));
jest.mock('@/hooks/useServerDrafts', () => ({ useServerDrafts: jest.fn() }));

import { mergeDrafts } from '../useDraftsList';
import { scheduledPostFixture } from '@/__fixtures__/scheduledPost';

/**
 * `mergeDrafts` is the drafts screen's order: device and account drafts in ONE
 * list, most recently changed first. The two halves carry their time in
 * different shapes — epoch milliseconds on a device draft, an ISO string on a
 * hydrated post — so a merge that compared them as they come would sort every
 * account draft to one end regardless of when it changed.
 */

function device(id: string, updatedAt: number): Draft {
  return {
    id,
    postContent: id,
    mediaIds: [],
    pollOptions: [],
    showPollCreator: false,
    location: null,
    threadItems: [],
    mentions: [],
    postingMode: 'thread',
    createdAt: updatedAt,
    updatedAt,
  };
}

function server(id: string, updatedAt: string): HydratedPost {
  const post = scheduledPostFixture({ id });
  return { ...post, metadata: { ...post.metadata, updatedAt } };
}

describe('mergeDrafts', () => {
  it('interleaves both origins by last change, newest first', () => {
    const merged = mergeDrafts(
      [device('device-new', Date.parse('2026-09-03T12:00:00.000Z')), device('device-old', Date.parse('2026-09-01T12:00:00.000Z'))],
      [server('server-mid', '2026-09-02T12:00:00.000Z'), server('server-newest', '2026-09-04T12:00:00.000Z')],
    );

    expect(merged.map((item) => `${item.origin}:${item.id}`)).toEqual([
      'server:server-newest',
      'device:device-new',
      'server:server-mid',
      'device:device-old',
    ]);
  });

  it('carries each draft through untouched, tagged with where it lives', () => {
    const post = server('server-1', '2026-09-02T12:00:00.000Z');
    const draft = device('device-1', Date.parse('2026-09-01T12:00:00.000Z'));

    const [first, second] = mergeDrafts([draft], [post]);

    expect(first).toEqual({ origin: 'server', id: 'server-1', updatedAt: Date.parse('2026-09-02T12:00:00.000Z'), post });
    expect(second).toEqual({ origin: 'device', id: 'device-1', updatedAt: draft.updatedAt, draft });
  });

  it('sorts an account draft with no readable time last rather than dropping it', () => {
    const merged = mergeDrafts(
      [device('device-1', Date.parse('2026-09-01T12:00:00.000Z'))],
      [server('server-undated', 'not a date')],
    );

    expect(merged.map((item) => item.id)).toEqual(['device-1', 'server-undated']);
  });
});
