import { beforeEach, describe, expect, it, vi } from 'vitest';

const find = vi.fn();
vi.mock('../../models/Trending', () => ({
  default: { find: (...args: unknown[]) => find(...args) },
}));
vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  getStoryIndex,
  refreshStoryIndex,
  resetStoryIndexCache,
  storyOf,
} from '../../services/trending/storyIndex';

const chain = (rows: unknown) => ({
  select: () => ({
    sort: () => ({
      limit: () => ({
        maxTimeMS: () => ({
          lean: () => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)),
        }),
      }),
    }),
  }),
});

/** Lets a background refresh settle before the assertion reads its result. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Mirrors `INDEX_TTL_MS` in the module under test. */
const INDEX_TTL_MS = 5 * 60 * 1000;

const NOW = new Date('2026-08-02T18:00:00Z');
const EARLIER = new Date('2026-08-02T17:30:00Z');

beforeEach(() => {
  resetStoryIndexCache();
  find.mockReset();
});

describe('refreshStoryIndex', () => {
  it('maps every member term of a merged row to the row it belongs to', async () => {
    find.mockReturnValue(
      chain([{ name: 'ukraine', terms: ['ukraine', 'kyiv', 'zelensky'], calculatedAt: NOW }]),
    );

    await refreshStoryIndex(0);
    const index = getStoryIndex(0);

    expect(index.get('kyiv')).toBe('ukraine');
    expect(index.get('zelensky')).toBe('ukraine');
    expect(index.get('eurovision')).toBeUndefined();
  });

  it('never mixes two batches', async () => {
    // An older batch describes a story that may since have been reshaped.
    // Merging the two would let one term belong to two stories at once.
    find.mockReturnValue(
      chain([
        { name: 'ukraine', terms: ['ukraine', 'kyiv'], calculatedAt: NOW },
        { name: 'kyiv', terms: ['kyiv', 'zelensky'], calculatedAt: EARLIER },
      ]),
    );

    await refreshStoryIndex(0);
    const index = getStoryIndex(0);

    expect(index.get('kyiv')).toBe('ukraine');
    expect(index.has('zelensky')).toBe(false);
  });

  it('never makes a reader wait — the first read is empty, not pending', () => {
    find.mockReturnValue(chain([{ name: 'ukraine', terms: ['ukraine', 'kyiv'], calculatedAt: NOW }]));

    // Synchronous by contract. Mongoose BUFFERS while a connection is down, so
    // an awaited read here would hold every feed request open until the buffer
    // timeout rather than failing fast — a ranking refinement becoming an
    // outage. A cold index costs one page its story penalty instead.
    expect(getStoryIndex(0).size).toBe(0);
  });

  it('memoizes an empty index on failure, so a broken database is not retried per request', async () => {
    find.mockReturnValue(chain(new Error('mongo down')));

    getStoryIndex(0);
    await flush();
    expect(getStoryIndex(1).size).toBe(0);
    await flush();

    expect(find).toHaveBeenCalledTimes(1);
  });

  it('serves the memo without asking again until it expires', async () => {
    find.mockReturnValue(chain([{ name: 'a', terms: ['a', 'b'], calculatedAt: NOW }]));

    getStoryIndex(0);
    await flush();
    getStoryIndex(INDEX_TTL_MS - 1);
    await flush();
    expect(find).toHaveBeenCalledTimes(1);

    getStoryIndex(INDEX_TTL_MS + 1);
    await flush();
    expect(find).toHaveBeenCalledTimes(2);
  });
});

describe('storyOf', () => {
  const index = new Map([
    ['kyiv', 'ukraine'],
    ['gaza', 'gaza'],
  ]);

  it('takes the FIRST matching term, so one post always lands in one story', () => {
    // A post can touch two stories — a comparison, a thread. Term order is
    // stable for a given post, so this is stable too; a "best match" rule would
    // make the penalty depend on which posts shared a page.
    expect(storyOf(['kyiv', 'gaza'], index)).toBe('ukraine');
    expect(storyOf(['gaza', 'kyiv'], index)).toBe('gaza');
  });

  it('answers null for a post in no story, and for an empty index', () => {
    expect(storyOf(['eurovision'], index)).toBeNull();
    expect(storyOf(undefined, index)).toBeNull();
    expect(storyOf(['kyiv'], new Map())).toBeNull();
  });
});
