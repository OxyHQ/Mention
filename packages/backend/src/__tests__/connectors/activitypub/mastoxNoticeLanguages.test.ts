/**
 * mastox.eu's mirror notice is free text, and free text has languages.
 *
 * The entry listed two of them, English and French. Eighteen of the fifty
 * mastox actors we hold carry a SPANISH notice, so the per-actor derivation
 * failed closed on every one: they kept `@name@mastox.eu` instead of
 * `@name@x.com`, and the notice stayed in their bio unstripped. Nothing errored
 * and nobody would report it — the account simply looks like an ordinary
 * Mastodon account, which is the failure mode this whole file exists to avoid.
 *
 * These are the wordings observed in production, kept verbatim so a future
 * change to the marker is measured against real data rather than an invented
 * example.
 */

import { FEDERATION_BRIDGE_POLICY } from '../../../connectors/activitypub/federationBridgePolicy';

const MASTOX = FEDERATION_BRIDGE_POLICY.find((entry) => entry.host === 'mastox.eu');

const NOTICES = {
  english: '(bot from x to mastodon managed by mastox.eu, contact @admin for any information)',
  french: '(bot de x à mastodon géré par mastox.eu, contactez @admin pour toute demande)',
  spanishHostQualified:
    '(bot de x a mastodon administrado por mastox.eu, por favor contacte con @admin@mastox.eu '
    + 'en inglés para cualquier información)',
  spanishBareAdmin:
    '(bot de x a mastodon administrado por mastox.eu, por favor contacte con @admin '
    + 'en inglés para cualquier información)',
};

/** Does any of the entry's boilerplate patterns claim this text? */
const stripped = (bio: string): string => {
  let out = bio;
  for (const pattern of MASTOX?.boilerplate ?? []) out = out.replace(pattern, '');
  return out.trim();
};

describe('mastox.eu mirror notice', () => {
  it('is an entry with relabel enabled', () => {
    // A vacuity floor: every assertion below is about MASTOX, and a renamed or
    // removed host would make them all pass by testing `undefined`.
    expect(MASTOX).toBeDefined();
    expect(MASTOX?.relabel).toBe('enabled');
    expect(MASTOX?.boilerplate.length).toBeGreaterThan(0);
  });

  it.each(Object.entries(NOTICES))('strips the %s notice', (_language, notice) => {
    expect(stripped(`Periodista y escritor. ${notice}`)).toBe('Periodista y escritor.');
  });

  it('leaves a bio that carries no notice completely alone', () => {
    const bio = 'Admin de mastox.eu. Contacto: @admin';
    expect(stripped(bio)).toBe(bio);
  });

  /**
   * The negative that matters most. The marker is what separates a MIRROR from
   * any other account on a stock Mastodon host — including the operator's own,
   * and including any human who simply signed up there. Match too loosely and
   * we publish a real person as an X account they may not have, which is the
   * impersonation-shaped error this file calls heavier than a wrong block.
   */
  it.each([
    ['the operator’s own profile', 'Cuenta oficial de mastox.eu, escribe a @admin'],
    ['an ordinary bio that mentions bots', 'Periodista. Escribo sobre política (y a veces sobre bots)'],
    ['the same notice naming a DIFFERENT host', '(bot de x a mastodon administrado por otrohost.eu, contacte con @admin)'],
  ])('does not claim %s', (_case, bio) => {
    expect(stripped(bio)).toBe(bio.trim());
  });
});

/**
 * Identity no longer reads the bio at all — that is the whole change.
 *
 * The notice pattern above still exists, but only to CLEAN text. If it ever
 * misses, a bio keeps one operator sentence; it can no longer decide whose
 * account this is, which is what a missed language used to do to 18 accounts.
 */
describe('mastox.eu identity is decided by the actor type', () => {
  const candidate = (over: Record<string, unknown> = {}) => ({
    host: 'mastox.eu',
    acct: 'pabloiglesias@mastox.eu',
    preferredUsername: 'PabloIglesias',
    actorUri: 'https://mastox.eu/users/PabloIglesias',
    actorType: 'Service',
    alsoKnownAs: [],
    fields: [],
    proxyOf: [],
    bio: '',
    ...over,
  });

  it('relabels a mirror whose bio carries NO notice in any language', () => {
    // Measured live: mastox publishes every mirror as a Service.
    expect(MASTOX?.derive(candidate())).toBe('PabloIglesias');
  });

  it('leaves the operator’s own Person account alone even so', () => {
    // Measured live: @admin is a Person. This is the case an exclusion list
    // would have had to enumerate, and this one does not need the list.
    expect(MASTOX?.derive(candidate({ actorType: 'Person', preferredUsername: 'admin' })))
      .toBeUndefined();
  });

  it('does not relabel a Person even when its bio DOES carry the notice', () => {
    // Proves the bio is not consulted for identity in either direction.
    expect(MASTOX?.derive(candidate({
      actorType: 'Person',
      bio: '(bot de x a mastodon administrado por mastox.eu, contacte con @admin)',
    }))).toBeUndefined();
  });
});
