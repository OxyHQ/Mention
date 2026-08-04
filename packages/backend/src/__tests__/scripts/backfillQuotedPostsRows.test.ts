import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * The quoted-post backfill, against REAL ROWS.
 *
 * `backfillQuotedPosts.test.ts` beside this one covers the two PURE decisions —
 * the `RE:` candidate filter and `extractApQuoteUri` — and is the right place for
 * those rules. This file exists for the one thing a pure test structurally cannot
 * see: WHICH STORE the script selects from and writes to.
 *
 * That is not hypothetical. The script arrived from `main` writing Mongo and
 * merged into the Postgres port with zero conflicts and zero type errors, because
 * `models/Post` is among the models the port kept. The pure suite stayed green
 * throughout — it never touches a store.
 *
 * Two properties beyond the store, both of which the Mongo original got wrong and
 * neither of which a counter can attest to on its own:
 *
 *  - `candidates` bounds the SCAN, so it distinguishes "the SQL filter kept a row
 *    out" from "the loop looked at it and skipped it". Without an assertion on it
 *    a body-only assertion passes either way.
 *  - A DRY RUN MUST NOT IMPORT. `ensureQuotedNote` stores what it fetches, so the
 *    Mongo version's token-free default invocation created rows while its own
 *    docblock promised "only `=false` writes".
 */

const mocks = vi.hoisted(() => ({ signedFetch: vi.fn() }));

vi.mock('../../connectors/activitypub/helpers', async () => {
  const actual = await vi.importActual<typeof import('../../connectors/activitypub/helpers')>(
    '../../connectors/activitypub/helpers',
  );
  // Partial, so `extractApQuoteUri` and `resolvePostIdFromObjectUri` stay REAL —
  // the second reads Postgres, which is the whole point of this file.
  return { ...actual, signedFetch: mocks.signedFetch };
});

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { outboxSyncService } from '../../connectors/activitypub/outbox.service';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { backfillQuotedPosts } from '../../scripts/backfillQuotedPosts';

const scope = serviceScope('quoted-posts-backfill');
const QUOTER = scope.user('quoter');
const QUOTED_AUTHOR = scope.user('quoted-author');

const QUOTED_URI = 'https://mastodon.social/users/lemonde/statuses/117030664429761672';

let seq = 0;

/** A federated post whose primary body is a rendered quote of `QUOTED_URI`. */
async function seedCandidate(body = `RE: ${QUOTED_URI}\n\n* Le combat a commencé`): Promise<string> {
  seq += 1;
  const record = await seedPost(scope, {
    oxyUserId: QUOTER,
    federation: { activityId: `https://mastodon.social/users/quoter/statuses/${seq}` },
    content: { variants: [{ source: 'author', tag: 'fr', text: body }] },
  });
  return record.id;
}

/** The post being quoted, already imported here. */
async function seedQuotedPost(): Promise<string> {
  const record = await seedPost(scope, {
    oxyUserId: QUOTED_AUTHOR,
    federation: { activityId: QUOTED_URI },
    content: { variants: [{ source: 'author', tag: 'fr', text: 'the quoted original' }] },
  });
  return record.id;
}

async function quoteOfRow(postId: string): Promise<string | null | undefined> {
  const [row] = await getDb()
    .select({ quoteOf: posts.quoteOf })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  return row?.quoteOf;
}

/** What the origin returns when the object is re-fetched. */
function respondWith(object: Record<string, unknown>): void {
  mocks.signedFetch.mockResolvedValue({
    ok: true,
    json: async () => object,
  } as unknown as Response);
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  vi.restoreAllMocks();
  mocks.signedFetch.mockReset();
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('quoted-post backfill — the rows, not the call', () => {
  it('links the stored POSTGRES row when the re-fetched object carries a quote URI', async () => {
    const quotedId = await seedQuotedPost();
    const candidateId = await seedCandidate();
    respondWith({ quoteUri: QUOTED_URI });

    const result = await backfillQuotedPosts({ dryRun: false });

    expect(await quoteOfRow(candidateId)).toBe(quotedId);
    expect(result.linked).toBe(1);
    expect(result.written).toBe(1);
    expect(result.noOpWrites).toBe(false);
  });

  it('leaves a candidate alone when the object carries no quote field', async () => {
    await seedQuotedPost();
    const candidateId = await seedCandidate();
    /**
     * The body says `RE: <url>` and the object says nothing. The body is a
     * filter, never the source of truth — reading it here would give a post a
     * quote it never had, on nothing but prose.
     *
     * The URL is left BARE rather than wrapped in `<p>…</p>`, deliberately: with
     * the wrapper, a body-scraping implementation captures the trailing tag too,
     * fails to resolve, and leaves the row null — so the damage would be visible
     * only in a counter. Bare, the wrong implementation resolves to the real
     * seeded post and MIS-LINKS it, which is the assertion below.
     */
    respondWith({ type: 'Note', content: `RE: ${QUOTED_URI}` });

    const result = await backfillQuotedPosts({ dryRun: false });

    expect(await quoteOfRow(candidateId)).toBeNull();
    expect(result.candidates).toBe(1);
    expect(result.withQuoteField).toBe(0);
    expect(result.written).toBe(0);
  });

  it('never SELECTS a federated post whose body is not a rendered quote', async () => {
    await seedQuotedPost();
    const plainId = await seedCandidate('RT: @Julio_Rodr_ ¡Tres años!');
    respondWith({ quoteUri: QUOTED_URI });

    const result = await backfillQuotedPosts({ dryRun: false });

    /**
     * TWO facts, and the row assertion alone cannot separate them: a post left
     * unlinked because the SQL filter never returned it, and one returned and
     * then skipped. Only the first is the contract — the filter exists so this
     * does not re-fetch every federated post ever stored.
     *
     * `candidates` counts rows the QUERY returned, so it is the fixture built in
     * that gap: 0 means the row was never fetched. Mutating the SQL predicate to
     * match everything reds this while leaving the row assertion green, because
     * `extractApQuoteUri` would then have been asked about a post nothing should
     * have looked at.
     */
    expect(await quoteOfRow(plainId)).toBeNull();
    expect(result.candidates).toBe(0);
    expect(mocks.signedFetch).not.toHaveBeenCalled();
  });

  it('a DRY RUN neither links nor IMPORTS — and says how many it declined to fetch', async () => {
    // Nothing local holds the quoted post, so a live run would go and get it.
    const candidateId = await seedCandidate();
    respondWith({ quoteUri: QUOTED_URI });
    const ensure = vi.spyOn(outboxSyncService, 'ensureQuotedNote');

    const result = await backfillQuotedPosts({ dryRun: true });

    /**
     * `ensureQuotedNote` STORES the Note it fetches. The Mongo original called it
     * on the dry-run path, so its default, confirmation-token-free invocation
     * created rows while the docblock promised "only `=false` writes".
     */
    expect(ensure).not.toHaveBeenCalled();
    expect(await quoteOfRow(candidateId)).toBeNull();
    expect(result.withQuoteField).toBe(1);
    expect(result.notHeldLocally).toBe(1);
    expect(result.linked).toBe(0);
    expect(result.written).toBe(0);
    // A dry run writing nothing is the contract, not the no-op failure.
    expect(result.noOpWrites).toBe(false);
  });

  it('a live run FETCHES a quoted post we do not hold, and links what comes back', async () => {
    const candidateId = await seedCandidate();
    respondWith({ quoteUri: QUOTED_URI });
    // Stand in for the import: the same id a real `ensureFederatedNote` would
    // return once it had stored the Note.
    const imported = await seedPost(scope, {
      oxyUserId: QUOTED_AUTHOR,
      content: { variants: [{ source: 'author', tag: 'fr', text: 'imported original' }] },
    });
    const ensure = vi
      .spyOn(outboxSyncService, 'ensureQuotedNote')
      .mockResolvedValue(imported.id);

    const result = await backfillQuotedPosts({ dryRun: false });

    expect(ensure).toHaveBeenCalledWith(QUOTED_URI);
    expect(await quoteOfRow(candidateId)).toBe(imported.id);
    expect(result.notHeldLocally).toBe(1);
    expect(result.written).toBe(1);
  });

  it('counts what POSTGRES reported MODIFYING, so a write that changed nothing is not work', async () => {
    const candidateId = await seedCandidate();
    respondWith({ quoteUri: QUOTED_URI });
    const imported = await seedPost(scope, {
      oxyUserId: QUOTED_AUTHOR,
      content: { variants: [{ source: 'author', tag: 'fr', text: 'imported original' }] },
    });
    /**
     * THE fixture in the gap, and the only shape that tells the two counters
     * apart. Every other case here updates exactly one row, so `written +=
     * updated.length` and `written += 1` agree — a suite made only of those
     * cannot see the difference the whole `noOpWrites` signal rests on.
     *
     * Here someone else links the post between the SELECT and the UPDATE (the
     * import step is the real window for that, which is why it is staged from
     * inside it). The UPDATE carries `quote_of is null` in its own WHERE, so it
     * matches NOTHING — Mongo's `modifiedCount: 0` with `matchedCount: 1`,
     * expressed in SQL. `linked` still counts 1, because a quote target really
     * was resolved, and `noOpWrites` fires precisely because those two disagree.
     */
    vi.spyOn(outboxSyncService, 'ensureQuotedNote').mockImplementation(async () => {
      await getDb().update(posts).set({ quoteOf: imported.id }).where(eq(posts.id, candidateId));
      return imported.id;
    });

    const result = await backfillQuotedPosts({ dryRun: false });

    expect(result.linked).toBe(1);
    expect(result.written).toBe(0);
    expect(result.noOpWrites).toBe(true);
    // The row is what the OTHER writer set it to, never re-stamped by this run.
    expect(await quoteOfRow(candidateId)).toBe(imported.id);
  });

  it('is idempotent — a linked post is no longer a candidate', async () => {
    await seedQuotedPost();
    await seedCandidate();
    respondWith({ quoteUri: QUOTED_URI });

    const first = await backfillQuotedPosts({ dryRun: false });
    const second = await backfillQuotedPosts({ dryRun: false });

    /**
     * `quote_of is null` is in the SELECT, so a linked row drops out of the
     * candidate set entirely. That is also what makes `BACKFILL_MAX` mean
     * something: successive runs advance instead of re-examining the same rows,
     * which the Mongo original's unordered pre-filter limit could not do.
     */
    expect(first.written).toBe(1);
    expect(second.candidates).toBe(0);
    expect(second.written).toBe(0);
    expect(second.noOpWrites).toBe(false);
  });
});
