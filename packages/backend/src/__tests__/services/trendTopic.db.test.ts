/**
 * `getTrendTopic` against real rows: the latest batch, the window's authors and
 * the stored graph. Its SQL is the thing that fails silently — the route answers
 * with the bare term on any error — so it has to run against a migrated schema.
 *
 * Runs in its own database (see `isolatedDatabaseFiles.ts`): the topic reads
 * the LATEST batch of the whole table, which any parallel suite would change.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PostUser } from '@mention/shared-types';

vi.mock('../../utils/knownUsers', () => ({
  resolveKnownUsers: vi.fn(async (ids: Iterable<string>) => {
    const users = new Map<string, PostUser>();
    for (const id of ids) users.set(id, { id, username: id, name: { displayName: id } });
    return users;
  }),
}));

import { connectPostgres, getDb, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { trendBatches, trending } from '../../db/schema/discovery';
import { getTrendTopic } from '../../services/trending/trendTopic';

let db: Database;
const RUN = randomUUID().slice(0, 8);
const TERM = `topic${RUN}`;
const NEIGHBOUR = `neighbour${RUN}`;

describe('getTrendTopic — the stored batch and the window, from rows', () => {
  beforeAll(async () => {
    db = await connectPostgres();
    const calculatedAt = new Date();

    await getDb().insert(trendBatches).values({ calculatedAt, summary: '' });

    await getDb()
      .insert(trending)
      .values([
        {
          type: 'entity',
          name: TERM,
          displayName: 'Topic Name',
          score: 5,
          volume: 3,
          authorCount: 2,
          momentum: 0.5,
          startedAt: calculatedAt,
          firstSeenAt: calculatedAt,
          scope: 'language',
          languages: ['en'],
          regions: [],
          calculatedAt,
          rank: 1,
        },
        {
          type: 'entity',
          name: NEIGHBOUR,
          displayName: 'Neighbour',
          score: 2,
          volume: 9,
          authorCount: 7,
          momentum: 0,
          calculatedAt,
          rank: 2,
        },
      ]);

    // Two authors, three posts about the term; the first author posts twice.
    for (const [author, count] of [
      [`alice-${RUN}`, 2],
      [`bob-${RUN}`, 1],
    ] as const) {
      for (let i = 0; i < count; i += 1) {
        await db.insert(posts).values({
          status: 'published',
          visibility: 'public',
          createdAt: new Date(Date.now() - 30 * 60 * 1000),
          oxyUserId: author,
          language: 'en',
          classificationTrendTerms: [TERM],
          metadataIsSensitive: false,
        });
      }
    }
  });

  it('answers the stored facts, the top authors and the neighbours from the batch', async () => {
    const topic = await getTrendTopic(TERM);

    expect(topic.term).toBe(TERM);
    expect(topic.displayName).toBe('Topic Name');
    expect(topic.volume).toBe(3);
    expect(topic.authorCount).toBe(2);
    expect(topic.scope).toBe('language');
    expect(topic.updatedAt).toBeDefined();
    expect(topic.topAuthors.map((user) => user.id)).toEqual([`alice-${RUN}`, `bob-${RUN}`]);
    // The neighbour has no edge in the stored graph, so nothing is related.
    expect(topic.related).toEqual([]);
  });

  it('answers the bare term for a topic that is not in the current batch', async () => {
    const absent = `absent${RUN}`;
    expect(await getTrendTopic(absent)).toEqual({ term: absent, topAuthors: [], related: [] });
  });
});
