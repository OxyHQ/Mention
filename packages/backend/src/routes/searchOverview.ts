/**
 * `GET /search/overview` — one request for the search screen's whole overview.
 *
 * ## What it replaces
 *
 * The screen issued SEVEN requests across THREE hosts and awaited all of them,
 * so the overview rendered at the speed of the slowest lane and each lane paid
 * its own TLS handshake, its own auth preflight and its own viewer-context
 * resolution. Head-of-line blocking was the design.
 *
 * ## Why it is mounted PUBLIC with `optionalAuth`
 *
 * `GET /search` sits on the authenticated API, which is why a signed-out viewer
 * cannot search posts at all today and why the client carries a
 * `canUsePrivateApi` gate that skips three lanes until the session lands. The
 * overview is mounted on the public API instead: the public lanes answer
 * everyone, and the lanes that genuinely need identity report `skipped` rather
 * than 401-ing the whole response.
 *
 * ## Lane statuses are part of the answer
 *
 * A lane that times out or fails is reported as such, with no items — never as
 * empty. The distinction is the contract's whole point (see
 * `@mention/shared-types`): an empty lane and a broken one look identical if you
 * only send an array, and the client then renders a confident "no results" for
 * an outage.
 */

import express, { type Response } from 'express';
import { SEARCH_OVERVIEW_LANE_LIMIT, type SearchLaneName } from '@mention/shared-types';

import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { logger } from '../utils/logger';
import { queryString } from '../utils/queryParams';
import {
  runSearchOverview,
  type LaneDefinition,
  type SkippedLane,
} from '../services/search/SearchOrchestrator';
import { searchHashtagsWithCounts } from '../services/search/hashtagSearch';
import {
  countListMembers,
  countPackMembers,
  feedLane,
  listLane,
  resolveLaneOwners,
  starterPackLane,
  toFeedPreviews,
  toListPreviews,
  toStarterPackPreviews,
} from '../services/search/overviewLanes';
import { getSharedLanes } from '../services/search/searchOverviewCache';
import { withStatementTimeout } from '../utils/withStatementTimeout';

const router = express.Router();

/**
 * Longest query honoured.
 *
 * Bounds the cache key space and the trigram work. A term longer than this is
 * truncated rather than refused: a paste is a plausible way to reach it, and a
 * 400 for a long paste is worse than searching its beginning.
 */
const MAX_QUERY_LENGTH = 200;

/**
 * Per-lane wall-clock budget.
 *
 * Generous relative to the measured cost of each lane now that they are
 * indexed (a selective list search is 0.19ms, a hashtag search 32ms), so this
 * is a backstop against a pathological plan rather than a routine cutoff. It is
 * deliberately NOT tuned to the fast path: a budget that trips in normal
 * operation turns a slow lane into a missing one for every viewer.
 */
const LANE_BUDGET_MS = 1_500;

/** The SQL half of the budget. Lower, because the query is the bounded part. */
const LANE_STATEMENT_BUDGET_MS = 1_000;

router.get('/overview', async (req: AuthRequest, res: Response) => {
  const raw = queryString(req.query.q) ?? queryString(req.query.query) ?? '';
  const query = raw.trim().slice(0, MAX_QUERY_LENGTH);
  const viewerId = req.user?.id;

  if (query.length === 0) {
    // An empty query is not an error and not a search. Answering with every
    // lane `skipped` keeps the client on one code path — it reads the same
    // shape whether or not it had a term.
    const empty = await runSearchOverview(
      '',
      [],
      // Total, so the client can read every key.
      ([
        'profiles', 'posts', 'hashtags', 'lists', 'feeds', 'starterPacks', 'saved',
      ] as SearchLaneName[]).map((name) => ({ name, status: 'skipped' as const })),
    );
    res.json(empty);
    return;
  }

  const limit = SEARCH_OVERVIEW_LANE_LIMIT;

  try {
    // The three viewer-independent lanes, cached together. Grouped rather than
    // cached individually because they share one key and one round trip — three
    // keys would be three Redis reads for one request.
    //
    // Started here and NOT awaited: each of the three lanes below awaits it
    // inside the orchestrator, so the lane's wall-clock budget and its
    // timeout/error status apply to it like any other lane. Awaiting it first
    // resolved the group before the orchestrator ever started, so the budget
    // raced an already-settled value and bounded nothing. One member over its
    // budget fails the group, so all three report that status: a partial group
    // must not be cached, and the member that did finish is not worth a second
    // code path.
    let servedFromCache = false;
    const shared = getSharedLanes(query, limit, async () => {
      const [hashtags, feeds, packs] = await Promise.all([
        // Every lane query runs on the `tx` its budget was set on. The budget
        // is `SET LOCAL`, so a query on any other connection runs unbounded.
        withStatementTimeout(LANE_STATEMENT_BUDGET_MS, (tx) =>
          searchHashtagsWithCounts(query, 0, limit, tx),
        ),
        withStatementTimeout(LANE_STATEMENT_BUDGET_MS, (tx) => feedLane(tx, query, limit)),
        withStatementTimeout(LANE_STATEMENT_BUDGET_MS, (tx) => starterPackLane(tx, query, limit)),
      ]);

      const owners = await resolveLaneOwners([feeds.rows, packs.rows]);
      const packMemberCounts = await countPackMembers(packs.rows.map((row) => row.id));

      return {
        hashtags: { items: hashtags.results, hasMore: hashtags.hasMore },
        feeds: { items: toFeedPreviews(feeds.rows, owners), hasMore: feeds.hasMore },
        starterPacks: {
          items: toStarterPackPreviews(packs.rows, owners, packMemberCounts),
          hasMore: packs.hasMore,
        },
      };
    }).then(({ value, fromCache }) => {
      servedFromCache = fromCache;
      return value;
    });
    // Each lane attaches its own handler, but one that loses its wall-clock
    // race stops listening; this keeps a later rejection from going unhandled.
    shared.catch(() => undefined);

    const lanes: LaneDefinition[] = [
      { name: 'hashtags', budgetMs: LANE_BUDGET_MS, run: async () => (await shared).hashtags },
      { name: 'feeds', budgetMs: LANE_BUDGET_MS, run: async () => (await shared).feeds },
      { name: 'starterPacks', budgetMs: LANE_BUDGET_MS, run: async () => (await shared).starterPacks },
      {
        name: 'lists',
        budgetMs: LANE_BUDGET_MS,
        run: async () => {
          const { rows, hasMore } = await withStatementTimeout(LANE_STATEMENT_BUDGET_MS, (tx) =>
            listLane(tx, query, limit, viewerId),
          );
          const [owners, memberCounts] = await Promise.all([
            resolveLaneOwners([rows]),
            countListMembers(rows.map((row) => row.id)),
          ]);
          return { items: toListPreviews(rows, owners, memberCounts), hasMore };
        },
      },
    ];

    const skipped: SkippedLane[] = [
      // Oxy owns people search. The key is reserved so the response shape does
      // not change the day it is folded in; do not build it here.
      { name: 'profiles', status: 'skipped' },
      // Not yet moved into the overview: both need post hydration, which
      // carries the viewer's privacy context and a Clarity link-preview budget.
      // Reported as `unavailable` rather than `skipped` because the client
      // still has to fetch them — `skipped` would say "there is nothing here".
      { name: 'posts', status: 'unavailable' },
      { name: 'saved', status: 'unavailable' },
    ];

    const overview = await runSearchOverview(query, lanes, skipped);
    // Still `false` if the group failed or outran its lanes' budgets — neither
    // was served from cache.
    res.json({ ...overview, servedFromCache });
  } catch (error) {
    // Only reachable if the ORCHESTRATOR itself fails: every lane's failure is
    // already a per-lane status, so this is not the path a slow database takes.
    logger.error('[SearchOverview] Failed to assemble the overview', { error });
    res.status(500).json({ error: 'Failed to search' });
  }
});

export default router;
