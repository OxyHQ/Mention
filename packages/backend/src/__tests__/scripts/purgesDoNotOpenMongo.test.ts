/**
 * The two blocked-domain purges must not reach MongoDB.
 *
 * ## Why this is a gate and not a note
 *
 * Both are run by GitHub workflows that derive their task definition from the
 * LIVE SERVICE's (`run-blocked-domain-content-purge.yml`,
 * `run-blocked-domain-purge.yml` — `describe-services` → `taskDefinition` → only
 * the image replaced). So they inherit whatever secrets the web service carries,
 * and the moment `MONGODB_URI` leaves that task definition, any Mongo connect
 * left on these paths fails at startup — before either script does a single unit
 * of the work it exists for. Nothing in either workflow would name Mongo as the
 * cause.
 *
 * ## What was actually removed, and why the comments mattered more than the code
 *
 * Each script opened a Mongo connection it never used, and each carried a
 * comment explaining why the connection was necessary. Both explanations were
 * FALSE by the time they were read:
 *
 *  - `purgeBlockedDomainContent` said `feed_interactions` still had a live Mongo
 *    writer. It does not — `purgeFeedInteractions` deletes through `getDb()`
 *    against the Postgres table, and the Mongoose model was deleted once nothing
 *    imported it.
 *  - `purgeBlockedDomainPlatformData` said its cursor rows live in Mongo. They
 *    live in Postgres; `lib/adminScriptCursor` reads and writes them through the
 *    Postgres pool.
 *
 * A stale justification is worse than an unexplained line, because it reads as a
 * decision somebody made on purpose — which is exactly why the removal is gated
 * rather than left to the next reader to re-derive.
 *
 * ## Read on SOURCE, deliberately
 *
 * The property is "this file does not reach Mongo", which is a claim about what
 * it IMPORTS. A runtime test cannot see an unused connection at all: the scripts
 * behaved identically with and without it, for as long as `MONGODB_URI` happened
 * to be present. The scan is floored on both files being found and non-trivial,
 * so a moved or renamed file fails loudly instead of passing by matching nothing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The scripts the two purge workflows invoke, by the path the workflows name. */
const PURGE_SCRIPTS = [
  'purgeBlockedDomainContent.ts',
  'purgeBlockedDomainPlatformData.ts',
] as const;

/**
 * Comments are stripped before matching. Both files legitimately DISCUSS Mongo —
 * one records that a shape guard used to be `mongoose.isValidObjectId` — and a
 * scan that counted prose would either fail on a correct file or force the
 * explanation out of the code, which is the opposite of what is wanted here.
 */
function codeOf(script: string): string {
  const source = readFileSync(path.resolve(__dirname, '../../scripts', script), 'utf8');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('the blocked-domain purges', () => {
  it.each(PURGE_SCRIPTS)('%s reaches no Mongo store', (script) => {
    const code = codeOf(script);

    // Floor: the file was found and is the real one, so a rename cannot make
    // this pass by matching an empty string.
    expect(code.length).toBeGreaterThan(1_000);
    expect(code).toContain('SCRIPT_NAME');

    expect(code).not.toContain('mongoose');
    expect(code).not.toContain('connectToDatabase');
    expect(code).not.toContain('utils/database');
  });

  it('still opens the store it DOES use', () => {
    // The mirror of the assertion above, and not redundant: "reaches no Mongo"
    // is satisfied just as well by a script that opens nothing at all, which
    // would be the same class of bug one store over — a one-shot gets none of
    // `server.ts`'s startup, so the pool it needs is the pool it opens.
    expect(codeOf('purgeBlockedDomainContent.ts')).toContain('connectPostgres');
  });
});
