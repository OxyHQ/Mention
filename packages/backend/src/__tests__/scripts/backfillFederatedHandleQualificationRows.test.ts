import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';

/**
 * The handle-qualification backfill, against REAL ROWS.
 *
 * `backfillHandleQualification.test.ts` beside this one covers the two PURE
 * functions (`qualifyBareHandles`, `identityDomainOfActor`) and is the right
 * place for the rewriting rules themselves. This file exists for the one thing a
 * pure test structurally cannot see: WHICH STORE the script writes to.
 *
 * That is not hypothetical here. The script arrived from `main` writing Mongo and
 * merged into the Postgres port with zero conflicts and zero type errors, because
 * `models/Post` and `models/FederatedActor` are among the models the port kept.
 * A pure-function suite stayed green throughout — it never touches a store — so
 * the only evidence that could have caught it is a row read back out of Postgres.
 *
 * The second property is the counting. `main`'s own fix added
 * `written`/`matched`/`noOpWrites` precisely so a silent no-op would be visible
 * (its first production run logged 213 written while modifying nothing). Pointed
 * at the wrong store that instrumentation reports a TRUE number about a table
 * nothing reads — so the count has to be asserted against rows too, not just
 * against itself.
 */

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { postContentVariants } from '../../db/schema/postContent';
import { federatedActors } from '../../db/schema/federation';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { backfillFederatedHandleQualification } from '../../scripts/backfillFederatedHandleQualification';

const scope = serviceScope('handle-qualification-backfill');
const SCOPE_PREFIX = `oxy-${scope.name}-`;
const BRIDGED_AUTHOR = scope.user('bridged-author');
const LOCAL_AUTHOR = scope.user('local-author');

let seq = 0;

/** A federated actor whose IDENTITY is on `x.com` but which arrived via a bridge. */
async function seedBridgedActor(oxyUserId: string): Promise<void> {
  seq += 1;
  await getDb()
    .insert(federatedActors)
    .values({
      oxyUserId,
      username: `bridged-${seq}`,
      domain: 'mastox.eu',
      acct: `${SCOPE_PREFIX}bridged-${seq}@mastox.eu`,
      uri: `https://mastox.eu/users/bridged-${seq}`,
      networkAcct: `bridged-${seq}@x.com`,
    });
}

/** One post owned by `owner`, whose primary variant carries `body`. */
async function seedBody(owner: string, body: string): Promise<string> {
  const record = await seedPost(scope, {
    oxyUserId: owner,
    content: { variants: [{ source: 'author', tag: 'en', text: body }] },
  });
  return record.id;
}

async function bodyOf(postId: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ body: postContentVariants.body })
    .from(postContentVariants)
    .where(eq(postContentVariants.postId, postId))
    .limit(1);
  return row?.body;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await getDb().delete(federatedActors).where(like(federatedActors.acct, `${SCOPE_PREFIX}%`));
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('handle-qualification backfill — the rows, not the call', () => {
  it('rewrites the stored POSTGRES body, qualifying onto the identity domain', async () => {
    await seedBridgedActor(BRIDGED_AUTHOR);
    const postId = await seedBody(BRIDGED_AUTHOR, 'hello @Julio_Rodr_ and welcome');

    const result = await backfillFederatedHandleQualification({ dryRun: false });

    /**
     * `x.com`, NOT `mastox.eu`. The actor arrived through the bridge but its
     * identity is upstream, and qualifying onto the delivering host would pin
     * every historical handle onto a hostname the account does not live on.
     */
    expect(await bodyOf(postId)).toBe('hello @Julio_Rodr_@x.com and welcome');
    expect(result.changed).toBe(1);
    expect(result.written).toBe(1);
    expect(result.noOpWrites).toBe(false);
  });

  it('writes NOTHING on a dry run, and still reports what it would change', async () => {
    await seedBridgedActor(BRIDGED_AUTHOR);
    const postId = await seedBody(BRIDGED_AUTHOR, 'hello @Julio_Rodr_ again');

    const result = await backfillFederatedHandleQualification({ dryRun: true });

    // The default is a dry run precisely so an operator can measure first.
    expect(await bodyOf(postId)).toBe('hello @Julio_Rodr_ again');
    expect(result.changed).toBe(1);
    expect(result.written).toBe(0);
    // NOT a no-op failure: a dry run writing nothing is the contract, and
    // conflating the two would fire this alarm on every rehearsal.
    expect(result.noOpWrites).toBe(false);
  });

  it('never touches a post whose author is not a federated actor', async () => {
    await seedBridgedActor(BRIDGED_AUTHOR);
    const localId = await seedBody(LOCAL_AUTHOR, 'hello @somebody here');

    const result = await backfillFederatedHandleQualification({ dryRun: false });

    /**
     * A bare handle on a LOCAL author's post already means the local account, so
     * qualifying it would rewrite a correct mention into a foreign one — measured
     * damage under the mutation: `hello @somebody@x.com here`.
     *
     * TWO layers hold this, and mutation-testing showed neither is individually
     * necessary for the OUTCOME: the SQL `inArray` filter keeps the local post
     * out of the result set, and the loop's `domainByUser` lookup skips it again.
     * Removing either alone leaves this green; removing BOTH reds it. That is
     * honest defence in depth rather than redundancy to delete — but it means the
     * body assertion cannot say which layer is live.
     *
     * `scanned` is the fixture built in that gap. It counts rows the query
     * RETURNED, so it distinguishes the two: with the SQL filter the local
     * variant is never FETCHED (0), and without it the loop reads and then skips
     * a row it should never have seen (1). One assertion for the guarantee, one
     * for the scan bound.
     */
    expect(await bodyOf(localId)).toBe('hello @somebody here');
    expect(result.changed).toBe(0);
    expect(result.scanned).toBe(0);
  });

  it('is idempotent — a second run finds nothing left to change', async () => {
    await seedBridgedActor(BRIDGED_AUTHOR);
    const postId = await seedBody(BRIDGED_AUTHOR, 'hello @Julio_Rodr_ once');

    await backfillFederatedHandleQualification({ dryRun: false });
    const second = await backfillFederatedHandleQualification({ dryRun: false });

    // An interrupted run has to be safe to resume, so a re-run must be a genuine
    // no-op rather than a second rewrite of already-qualified text.
    expect(await bodyOf(postId)).toBe('hello @Julio_Rodr_@x.com once');
    expect(second.changed).toBe(0);
    expect(second.written).toBe(0);
  });

  it('counts what POSTGRES reported, so a write that changed nothing is not counted as work', async () => {
    await seedBridgedActor(BRIDGED_AUTHOR);
    await seedBody(BRIDGED_AUTHOR, 'hello @Julio_Rodr_ counted');

    const result = await backfillFederatedHandleQualification({ dryRun: false });

    /**
     * THE property `main`'s `.lean()` fix existed for, ported. `written` comes
     * from `returning().length` — rows Postgres says it updated — so it can never
     * be the count of update calls issued. `matched` moves with it for the same
     * reason.
     *
     * The assertion is deliberately against the ROW as well as the counter: a
     * counter agreeing with itself is exactly what the wrong-store version did.
     */
    expect(result.written).toBe(result.changed);
    expect(result.matched).toBe(result.written);
    expect(result.noOpWrites).toBe(false);
    expect(result.samples[0]?.after).toContain('@Julio_Rodr_@x.com');
  });
});
