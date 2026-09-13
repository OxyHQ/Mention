/**
 * Statement budget: gathering Explore's candidate pool must cost NOTHING in
 * child-table statements, no matter how many candidates the pool holds — only
 * the final PAGE, after ranking/dedup/slicing, is worth a 9-table join.
 *
 * Mirrors `forYouCandidateGatheringStatementBudget.test.ts`, for the same
 * reason: `exploreSource.gather` used to call `assemblePostRecords` on its
 * WHOLE fetched window (`cap = limit * candidateMultiplier`) before this fix,
 * exactly the pattern For You's lanes were fixed for — see
 * `discoverySources.ts`'s `exploreSource` doc comment.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../../config';
import { closePostgres, connectPostgres } from '../../db/postgres';
import { metrics } from '../../utils/metrics';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import { exploreSource } from '../../mtn/feed/engine/sources/discoverySources';
import type { FeedEngineContext } from '../../mtn/feed/engine/types';

const scope = postScope('explore-candidate-gathering-budget');

let previousInstrumentationSetting = false;

beforeAll(async () => {
  previousInstrumentationSetting = config.postgres.queryMetricsEnabled;
  config.postgres.queryMetricsEnabled = true;
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
  config.postgres.queryMetricsEnabled = previousInstrumentationSetting;
});

beforeEach(() => {
  metrics.reset();
});

/** Every table `assemblePostRecords`'s `loadChildRows` reads, one query each. */
const CHILD_TABLES = [
  'post_authorships',
  'post_content_variants',
  'post_media',
  'post_attachments',
  'post_sources',
  'post_mentions',
  'post_classification_topic_refs',
] as const;

async function childTableStatementCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const line of (await metrics.getPrometheusFormat()).split('\n')) {
    const match = /^db_query_duration_ms_count\{[^}]*table="([^"]+)"[^}]*\}\s+(\d+)/.exec(line);
    if (match && (CHILD_TABLES as readonly string[]).includes(match[1])) {
      counts.set(match[1], (counts.get(match[1]) ?? 0) + Number(match[2]));
    }
  }
  return counts;
}

const CTX: FeedEngineContext = { currentUserId: undefined };

describe('Explore candidate gathering — statement budget', () => {
  it('gathers shells with zero child-table statements, marked _unassembled', async () => {
    await Promise.all(Array.from({ length: 5 }, () => seedPost(scope)));

    metrics.reset();
    const candidates = await exploreSource.gather(CTX, {}, 20);

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((post) => post._unassembled === true)).toBe(true);
    expect(candidates.every((post) => typeof post.finalScore === 'number')).toBe(true);

    const counts = await childTableStatementCounts();
    expect(counts.size).toBe(0);

    await clearPostScope(scope);
  });
});
