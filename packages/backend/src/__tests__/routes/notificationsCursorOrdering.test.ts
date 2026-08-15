/**
 * The notifications list opens on the NEWEST notification, for an account whose
 * rows straddle the cutover.
 *
 * `id` is `text` holding a 24-char ObjectId hex for every pre-cutover row and a
 * uuid v7 for everything created after, and `'0' < '6'` under the database's
 * collation (`en_US.utf8`, verified on the server). Ordering the list on `id`
 * alone — which it did — therefore places EVERY post-cutover notification below
 * EVERY pre-cutover one. A migrated account opened its tab on its oldest
 * notifications and could not reach anything that happened since the cutover
 * without paging through the whole backlog; it self-heals only once the 90-day
 * retention sweep clears the old cohort.
 *
 * So every fixture here is MIXED on purpose. A suite seeded with one id shape
 * cannot see this defect at all: within either cohort alone, `id DESC` and
 * `created_at DESC` agree, which is exactly why the pre-existing pagination
 * tests (`notificationsList.test.ts`) passed throughout.
 *
 * Three separate things are asserted, because each fails on its own:
 *
 *  - the ORDER — the first page is the newest rows;
 *  - the WALK — paging to the end visits every row exactly once, which is what a
 *    keyset comparing the `(created_at, id)` PAIR buys and a bare `created_at`
 *    comparison would lose the moment two rows share a millisecond;
 *  - the PLAN — the index really serves that order, with no Sort node.
 */

import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  hydratePosts: vi.fn(),
  getUsersByIds: vi.fn(),
  createScopedOxyClient: vi.fn(),
  loadFollowedAuthorIds: vi.fn(),
}));

vi.mock('../../middleware/rateLimiter', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: mocks.hydratePosts },
}));
vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: mocks.createScopedOxyClient,
  // The route hands this to `resolveNotificationInboxIds`; a module factory
  // replaces the WHOLE module, so an export the route calls and this factory
  // omits is `undefined is not a function` on every request. Which recipient ids
  // the inbox covers is `notificationsChannelInbox.test.ts`'s subject; held at
  // "just the viewer" here so these cases stay about pagination and ordering.
  createUserScopedOxyServices: () => undefined,
  getServiceOxyClient: () => ({ getUsersByIds: mocks.getUsersByIds }),
}));
vi.mock('../../utils/push', () => ({
  sendPushToUser: vi.fn(),
  formatPushForNotification: vi.fn(),
}));
vi.mock('../../services/viewerFollowGraph', () => ({
  loadFollowedAuthorIds: mocks.loadFollowedAuthorIds,
}));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { uuidv7 } from '@oxyhq/db';
import { notifications } from '../../db/schema/discovery';
import notificationsRouter, { NOTIFICATION_PAGE_ORDER } from '../../routes/notifications';

let db: Database;
const createdRecipientIds: string[] = [];

/**
 * Vitest runs test FILES in parallel against ONE database, so this file owns its
 * recipients rather than sharing an id-shaped literal with any other suite —
 * `src/__tests__/fixtureIdOwnership.test.ts` gates that rule.
 */
const NAMESPACE = `notif-order-${randomUUID().slice(0, 8)}`;

function viewerId(): string {
  const id = `oxy-${NAMESPACE}-${randomUUID()}`;
  createdRecipientIds.push(id);
  return id;
}

/**
 * A 24-char ObjectId hex of the shape a REAL pre-cutover row carries.
 *
 * The leading 8 hex characters are a Unix timestamp in seconds, which for every
 * id Mention ever minted begins with `6` — and that is the entire hazard, since
 * a uuid v7's leading nibble is `0` for the next few thousand years. A
 * zero-padded counter (`000000000000000000000001`) is a 24-char hex string that
 * looks like the same fixture and stages NOTHING: it sorts below the uuids, the
 * same side as a correct implementation would put it, so every assertion passes
 * for the wrong reason. The collation floor below is what keeps that from
 * quietly happening again.
 */
function objectIdShaped(index: number): string {
  const seconds = Math.floor(new Date('2025-01-01T00:00:00.000Z').getTime() / 1000) + index;
  return seconds.toString(16).padStart(8, '0') + index.toString(16).padStart(16, '0');
}

/** One notification, with the id shape and the instant both pinned by the case. */
async function seed(recipient: string, id: string, createdAt: Date, entity: string) {
  await db.insert(notifications).values({
    id,
    recipientId: recipient,
    actorId: `oxy-${NAMESPACE}-actor`,
    type: 'like',
    entityId: entity,
    entityType: 'post',
    createdAt,
  });
}

function makeApp(viewer: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { user: { id: string } }).user = { id: viewer };
    next();
  });
  app.use('/', notificationsRouter);
  return app;
}

interface PagedRow {
  _id: string;
}

async function page(viewer: string, limit: number, cursor?: string) {
  const query: Record<string, string | number> = { limit };
  if (cursor) query.cursor = cursor;
  const res = await request(makeApp(viewer)).get('/').query(query).expect(200);
  return {
    ids: (res.body.notifications as PagedRow[]).map((n) => n._id),
    nextCursor: res.body.nextCursor as string | undefined,
    hasMore: res.body.hasMore as boolean,
  };
}

/** Walk the list to exhaustion, returning every id in the order it was served. */
async function walk(viewer: string, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  // Bounded so a pagination bug that never advances fails the assertion instead
  // of hanging the suite.
  for (let guard = 0; guard < 20; guard += 1) {
    const result = await page(viewer, limit, cursor);
    seen.push(...result.ids);
    if (!result.hasMore || !result.nextCursor) return seen;
    cursor = result.nextCursor;
  }
  throw new Error('notifications pagination did not terminate');
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUsersByIds.mockResolvedValue([]);
  mocks.createScopedOxyClient.mockReturnValue({ scope: 'viewer' });
  mocks.loadFollowedAuthorIds.mockResolvedValue(new Set<string>());
  mocks.hydratePosts.mockResolvedValue([]);
});

afterEach(async () => {
  if (createdRecipientIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.recipientId, createdRecipientIds));
    createdRecipientIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

/** The subset of `EXPLAIN (FORMAT JSON)` this file walks. */
interface ProbePlanNode {
  'Node Type': string;
  Plans?: ProbePlanNode[];
}

describe('the fixture really stages the collation hazard', () => {
  it('sorts the pre-cutover id ABOVE the post-cutover one, in the database', async () => {
    /**
     * The vacuity floor for every ordering case below. They all rest on one fact
     * — that `order by id desc` puts the OLD row first — and that fact lives in
     * the database's collation, not in this file. Asserted where it is decided:
     * a fixture that stopped reproducing it (a zero-padded counter, say, or a
     * collation change) would leave those tests passing while measuring nothing,
     * and this goes red instead. `>` rather than a sort so the message names the
     * two values.
     */
    const objectId = objectIdShaped(1);
    const uuid = uuidv7();
    const [row] = await db
      .select({ objectIdSortsFirst: sql<boolean>`${objectId}::text > ${uuid}::text` })
      .from(sql`(select 1) as probe`);
    expect(row.objectIdSortsFirst).toBe(true);
  });
});

describe('GET /notifications — a migrated account sees its newest notifications first', () => {
  /**
   * Two pre-cutover ObjectId rows, then two post-cutover uuid rows, in real
   * chronological order. Under `order by id desc` the two ObjectIds come back
   * FIRST because `'6' > '0'`, so the page opens on the two OLDEST rows.
   */
  async function seedStraddlingCohort(viewer: string) {
    const rows = [
      { id: objectIdShaped(1), at: '2025-01-01T00:00:00.000Z', label: 'oldest' },
      { id: objectIdShaped(2), at: '2025-06-01T00:00:00.000Z', label: 'old' },
      { id: uuidv7(), at: '2026-06-01T00:00:00.000Z', label: 'recent' },
      { id: uuidv7(), at: '2026-07-01T00:00:00.000Z', label: 'newest' },
    ];
    for (const row of rows) {
      await seed(viewer, row.id, new Date(row.at), `${NAMESPACE}-${row.label}`);
    }
    return rows;
  }

  it('serves the newest first, not every pre-cutover row first', async () => {
    const viewer = viewerId();
    const rows = await seedStraddlingCohort(viewer);

    const first = await page(viewer, 2);
    expect(first.ids).toEqual([rows[3].id, rows[2].id]);
  });

  it('walks the whole list in chronological order, newest to oldest', async () => {
    const viewer = viewerId();
    const rows = await seedStraddlingCohort(viewer);

    // Page size 1, so EVERY step crosses a boundary — including the one between
    // the two id cohorts, which is the boundary the old cursor could not cross.
    await expect(walk(viewer, 1)).resolves.toEqual([
      rows[3].id,
      rows[2].id,
      rows[1].id,
      rows[0].id,
    ]);
  });

  it('visits every row exactly once across a boundary inside one millisecond', async () => {
    /**
     * `created_at` defaults to `date_trunc('milliseconds', now())` and `now()` is
     * `transaction_timestamp()`, so a fan-out written in one transaction shares
     * it EXACTLY — the ordinary case, not a contrived one. This stages that: four
     * rows on one instant, mixed shapes, paged one at a time so every step lands
     * inside the tied group. A keyset comparing `created_at` alone would either
     * serve the same row forever or skip the rest of the group.
     */
    const viewer = viewerId();
    const sameInstant = new Date('2026-05-05T05:05:05.000Z');
    const ids = [
      objectIdShaped(11),
      objectIdShaped(12),
      uuidv7(),
      uuidv7(),
    ];
    await db.transaction(async (tx) => {
      for (const [index, id] of ids.entries()) {
        await tx.insert(notifications).values({
          id,
          recipientId: viewer,
          actorId: `oxy-${NAMESPACE}-actor`,
          type: 'like',
          entityId: `${NAMESPACE}-tied-${index}`,
          entityType: 'post',
          createdAt: sameInstant,
        });
      }
    });

    const seen = await walk(viewer, 1);
    expect(seen).toHaveLength(ids.length);
    expect(new Set(seen)).toEqual(new Set(ids));
    // Within one instant the tiebreak decides, and it must be the SAME comparison
    // the keyset uses — descending text order, whatever the shapes.
    expect(seen).toEqual([...ids].sort().reverse());
  });

  it('the tied fixture really does share one created_at', async () => {
    /**
     * The vacuity floor for the case above: it is about what happens when
     * `created_at` cannot separate rows, so if the fixture ever stopped tying,
     * that test would keep passing while proving nothing.
     */
    const viewer = viewerId();
    const at = new Date('2026-05-05T05:05:05.000Z');
    await seed(viewer, objectIdShaped(21), at, `${NAMESPACE}-tie-a`);
    await seed(viewer, uuidv7(), at, `${NAMESPACE}-tie-b`);

    const stamps = await db
      .select({ createdAt: notifications.createdAt })
      .from(notifications)
      .where(eq(notifications.recipientId, viewer));
    expect(stamps).toHaveLength(2);
    expect(stamps[0].createdAt.getTime()).toBe(stamps[1].createdAt.getTime());
  });
});

describe('GET /notifications — the index actually serves that order', () => {
  it('plans the page without a Sort node', async () => {
    /**
     * A cursor change without its index is a hot route sorting a user's entire
     * notification history on every page, and it is INVISIBLE in the response —
     * the rows are identical either way. So the plan is the assertion.
     *
     * Measured against a PRIVATE table, not `notifications`, and that is the
     * whole design. The earlier version EXPLAINed the real table with seq and
     * bitmap scans disabled, which narrows the planner's options but does not
     * remove its CHOICE: `notifications` carries several indexes, every other
     * file in a parallel run writes rows that move its statistics, and the
     * planner then picks a different index and adds a Sort that says nothing
     * about this ORDER BY. It passed alone and failed once the suite grew — the
     * same substitution the sibling gate in `db/chronoOrderPlan.test.ts` was
     * rewritten for: "the planner chose the good plan" is not the property,
     * "the ORDER BY is spelled so an index CAN serve it" is.
     *
     * `on commit drop` inside one transaction: invisible to other connections,
     * nothing waits on it, and with exactly ONE index the planner has no choice
     * left to make. `format json` with an exact `Node Type` match, because the
     * substring `Sort` also matches `Incremental Sort` — a BETTER plan whose
     * name contains the word, and a gate that fails on a correct plan is the one
     * whoever hits it next deletes.
     *
     * The negative control is what keeps it honest: drizzle emits `.desc()` in
     * index DDL as `DESC NULLS LAST` while a query's `desc()` means `DESC NULLS
     * FIRST`, and pathkey matching compares the NULLS placement too — so the
     * wrong spelling must still produce a Sort here, or this table is not
     * reproducing the hazard.
     */
    const nodeTypes = async (order: string): Promise<string[]> => {
      const plan = await db.transaction(async (tx) => {
        await tx.execute(sql`
          create temp table notif_order_probe (
            id text primary key,
            recipient_id text not null,
            created_at timestamptz not null
          ) on commit drop
        `);
        await tx.execute(sql`
          create index notif_order_probe_idx
            on notif_order_probe (recipient_id, created_at desc nulls last, id desc nulls last)
        `);
        await tx.execute(sql`
          insert into notif_order_probe
          select lpad(g::text, 24, '0'), 'probe-viewer', now() - (g || ' seconds')::interval
          from generate_series(1, 2000) g
        `);
        await tx.execute(sql`analyze notif_order_probe`);
        const rows = await tx.execute<{ 'QUERY PLAN': [{ Plan: ProbePlanNode }] }>(sql`
          explain (format json) select id from notif_order_probe
          where recipient_id = 'probe-viewer'
          order by ${sql.raw(order)} limit 21
        `);
        return [...rows][0]['QUERY PLAN'][0].Plan;
      });
      const types: string[] = [];
      const walk = (node: ProbePlanNode): void => {
        types.push(node['Node Type']);
        for (const child of node.Plans ?? []) walk(child);
      };
      walk(plan);
      return types;
    };

    // The order string is RENDERED from the exported constant, not written out
    // here — otherwise this probe would assert that a hand-written spelling works
    // against a hand-built index and would keep passing after the route changed
    // its order, which is the substitution this whole file exists to catch. The
    // column names are rewritten to the probe table's, which carry the same
    // names, so what is under test is the ORDER and its NULLS placement.
    const rendered = db
      .select({ id: notifications.id })
      .from(notifications)
      .orderBy(...NOTIFICATION_PAGE_ORDER)
      .toSQL()
      .sql.toLowerCase()
      .split('order by')[1]
      .trim()
      .replace(/"notifications"\./g, '')
      .replace(/"/g, '');

    expect(rendered).toContain('nulls last');
    expect(await nodeTypes(rendered)).not.toContain('Sort');
    // Negative control: drizzle's bare `desc()` spelling is NULLS FIRST, which
    // the index cannot serve. If this stops sorting, the probe has stopped
    // reproducing the hazard and the assertion above means nothing.
    expect(await nodeTypes('created_at desc, id desc')).toContain('Sort');
  });
});
