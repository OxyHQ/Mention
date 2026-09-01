/**
 * A one-shot script that will reach `getPostCreator()` has to REGISTER the
 * service first — and the only way this bug happens is a script forgetting to.
 *
 * `PostCreationService` registers itself as a side effect of being imported, and
 * the HTTP server imports it on the way to mounting routes. A script mounts no
 * routes, so the registry is empty and every path ending in `getPostCreator()`
 * throws. The quoted-post backfill's first live run on PostgreSQL reported 908
 * posts with a quote field, 908 un-importable and 0 linked: all of them this
 * throw, swallowed by a best-effort catch, exit code 0.
 *
 * So this asserts the CALL SITES, not the helper. A test that only proved
 * `registerAdminScriptServices()` works would stay green through exactly the
 * failure it is meant to guard — which is what the first version of it did.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS_DIR = join(__dirname, '../../scripts');

/**
 * Scripts that reach `getPostCreator()`, by the route they take. Listed rather
 * than discovered: the reach is several frames deep through
 * `outboxSyncService`, so a shallow import scan would miss both of them and a
 * full module-graph walk is `oneShotPoolCoverage`'s job, not this file's.
 */
const SCRIPTS_REACHING_POST_CREATOR = [
  // → ensureQuotedNote → ensureFederatedNote → getPostCreator().create
  'backfillQuotedPosts.ts',
  // → ensureFederatedReplyLink → resolveThreadLink → ensureFederatedNote → …
  'backfillFederatedThreadLinks.ts',
] as const;

const read = (file: string): string => readFileSync(join(SCRIPTS_DIR, file), 'utf8');

describe('admin scripts that create posts register the creator', () => {
  it.each(SCRIPTS_REACHING_POST_CREATOR)('%s calls registerAdminScriptServices', (file) => {
    expect(read(file)).toContain('registerAdminScriptServices()');
  });

  /**
   * The vacuity floor. Without it, renaming the helper would make every case
   * above pass by finding nothing anywhere — the check would still be green and
   * would be guarding nothing at all.
   */
  it('is looking for a helper that exists and is exported', () => {
    const lifecycle = readFileSync(join(SCRIPTS_DIR, 'lib/adminScriptLifecycle.ts'), 'utf8');
    expect(lifecycle).toContain('export async function registerAdminScriptServices');
    expect(SCRIPTS_REACHING_POST_CREATOR.length).toBeGreaterThan(1);
  });
});
