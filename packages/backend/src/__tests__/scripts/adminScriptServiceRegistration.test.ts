/**
 * A one-shot script has to REGISTER the services it will reach, not merely be
 * able to import them.
 *
 * `PostCreationService` registers itself with the service registry as a side
 * effect of being imported, and the HTTP server imports it on the way to
 * mounting routes — so inside the app the registry is populated by the time
 * anything creates a post. A script imports no routes, so it is not.
 *
 * This is not hypothetical. The quoted-post backfill's first live run on
 * PostgreSQL reported 908 candidates with a quote field, 908 un-importable and
 * 0 linked; every one of them had failed with "PostCreator not registered".
 * Nothing errored, the exit code was 0, and the tally read exactly like remote
 * instances refusing us.
 */

import { describe, expect, it } from 'vitest';
import { getPostCreator } from '../../services/serviceRegistry';
import { registerAdminScriptServices } from '../../scripts/lib/adminScriptLifecycle';

describe('admin script service registration', () => {
  it('makes the post creator reachable, which is the whole point', async () => {
    await registerAdminScriptServices();
    // `getPostCreator` THROWS when unregistered — asserting it returns is
    // asserting the exact failure the backfill hit.
    expect(() => getPostCreator()).not.toThrow();
    expect(getPostCreator()).toBeDefined();
  });

  it('is safe to call twice, since a script may bootstrap defensively', async () => {
    await registerAdminScriptServices();
    await registerAdminScriptServices();
    expect(() => getPostCreator()).not.toThrow();
  });
});
