/**
 * `findActorOxyUserIdsByAccts` — the typed remote handles of one post
 * (`@bob@remote.tld`), answered in ONE query rather than one per handle.
 * Against real rows, because the answer is only as good as the `acct` column
 * it reads: an acct we store without an Oxy id yet must not resolve.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres } from '../../db/postgres';
import { findActorOxyUserIdsByAccts } from '../../db/federation/actorRepository';
import { clearFederationScope, federationScope, seedActor } from '../helpers/federationFixtures';

const scope = federationScope('federation-acct-lookup');

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('findActorOxyUserIdsByAccts', () => {
  it('maps every stored, linked acct to its Oxy id and leaves the rest out', async () => {
    await seedActor(scope, { username: 'bob', oxyUserId: 'oxy-bob' });
    await seedActor(scope, { username: 'carol', oxyUserId: 'oxy-carol' });
    await seedActor(scope, { username: 'unlinked', oxyUserId: null });

    const ids = await findActorOxyUserIdsByAccts([
      `bob@${scope.domain}`,
      `carol@${scope.domain}`,
      `unlinked@${scope.domain}`,
      `nobody@${scope.domain}`,
    ]);

    expect(ids).toEqual(
      new Map([
        [`bob@${scope.domain}`, 'oxy-bob'],
        [`carol@${scope.domain}`, 'oxy-carol'],
      ]),
    );
  });

  it('asks nothing for an empty list', async () => {
    expect(await findActorOxyUserIdsByAccts([])).toEqual(new Map());
  });
});
