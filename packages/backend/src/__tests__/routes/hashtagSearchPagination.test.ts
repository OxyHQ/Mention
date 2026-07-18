import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route coverage for `GET /hashtags/search` offset pagination.
 *
 * The handler was hard-capped at 5 tags with no offset. It now over-fetches one
 * row past `limit` to detect `hasMore` and pages via `$skip`/`$limit` on a stable
 * `{ count desc, tag asc }` sort. The aggregation is mocked to a fixed, already
 * ranked result set so the test asserts the handler's window + `hasMore` logic
 * (and that the offset/limit actually reach the pipeline).
 */

const { aggregate } = vi.hoisted(() => ({ aggregate: vi.fn() }));

vi.mock('../../models/Post', () => ({ default: { aggregate } }));

import hashtagsRoutes from '../../routes/hashtags';

const app = express();
app.use(express.json());
app.use('/hashtags', hashtagsRoutes);

// Ranked tags the aggregation would return (count desc). The mock applies only the
// pipeline's $skip/$limit — every seeded tag is treated as matching the query.
const RANKED = Array.from({ length: 5 }, (_, i) => ({ tag: `tag${i}`, count: 100 - i }));

function pipelineStage(pipeline: Array<Record<string, unknown>>, op: string): Record<string, unknown> | undefined {
  return pipeline.find((stage) => op in stage);
}

beforeEach(() => {
  vi.clearAllMocks();
  aggregate.mockImplementation((pipeline: Array<Record<string, unknown>>) => {
    const skip = Number(pipelineStage(pipeline, '$skip')?.$skip ?? 0);
    const limit = Number(pipelineStage(pipeline, '$limit')?.$limit ?? RANKED.length);
    return Promise.resolve(RANKED.slice(skip, skip + limit));
  });
});

describe('GET /hashtags/search — pagination', () => {
  it('rejects a missing query with 400', async () => {
    await request(app).get('/hashtags/search').expect(400);
  });

  it('over-fetches to report hasMore and returns exactly `limit` rows on a full page', async () => {
    const res = await request(app).get('/hashtags/search').query({ query: 'tag', limit: 2, offset: 0 }).expect(200);

    expect(res.body.hashtags.map((h: { tag: string }) => h.tag)).toEqual(['tag0', 'tag1']);
    expect(res.body.pagination).toMatchObject({ offset: 0, limit: 2, hasMore: true });

    // The over-fetch (`limit + 1`) and the offset both reach the aggregation.
    const pipeline = aggregate.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(pipelineStage(pipeline, '$skip')).toEqual({ $skip: 0 });
    expect(pipelineStage(pipeline, '$limit')).toEqual({ $limit: 3 });
    expect(pipelineStage(pipeline, '$sort')).toEqual({ $sort: { count: -1, _id: 1 } });
  });

  it('pages with a stable order and never repeats a tag', async () => {
    const seen: string[] = [];
    let offset = 0;
    let guard = 0;

    for (;;) {
      const res = await request(app).get('/hashtags/search').query({ query: 'tag', limit: 2, offset }).expect(200);
      seen.push(...res.body.hashtags.map((h: { tag: string }) => h.tag));
      if (!res.body.pagination.hasMore) break;
      offset = res.body.pagination.offset + res.body.pagination.limit;
      if (++guard > 10) throw new Error('pagination did not terminate');
    }

    expect(seen).toEqual(['tag0', 'tag1', 'tag2', 'tag3', 'tag4']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('reports hasMore=false when the result set fits within the default page', async () => {
    const res = await request(app).get('/hashtags/search').query({ query: 'tag' }).expect(200);
    expect(res.body.hashtags).toHaveLength(5);
    expect(res.body.pagination.hasMore).toBe(false);
  });
});
