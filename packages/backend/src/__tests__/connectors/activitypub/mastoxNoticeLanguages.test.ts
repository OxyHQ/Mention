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
