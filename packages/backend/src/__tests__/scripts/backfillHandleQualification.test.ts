/**
 * The backfill's one piece of real logic: which stored bodies change, and which
 * are left completely alone.
 *
 * A post body is written ONCE — unlike an actor's bio, which every refresh
 * rewrites — so everything imported before handle qualification keeps a bare
 * `@Julio_Rodr_` that reads as a local name. The repair has to agree exactly
 * with the live path, which is why it calls the same `qualifyBareHandles`
 * rather than a rule of its own; these cases pin the behaviour that matters at
 * the boundary the script owns.
 */

import { qualifyBareHandles } from '@mention/shared-types/textEntities';
import { identityDomainOfActor } from '../../connectors/activitypub/identityDomain';

/** Mirrors the script's per-post decision: the new variants, or null if unchanged. */
function qualifyVariants(
  variants: Array<{ source?: string; text?: string }>,
  domain: string,
): Array<{ source?: string; text?: string }> | null {
  let changed = false;
  const next = variants.map((variant) => {
    if (typeof variant.text !== 'string') return variant;
    const text = qualifyBareHandles(variant.text, domain);
    if (text === variant.text) return variant;
    changed = true;
    return { ...variant, text };
  });
  return changed ? next : null;
}

describe('backfill: which bodies change', () => {
  it('qualifies a bare handle against the IDENTITY domain, not the bridge host', () => {
    const domain = identityDomainOfActor({ networkAcct: 'pabloiglesias@x.com', domain: 'mastox.eu' });
    const next = qualifyVariants([{ source: 'author', text: 'RT: @Julio_Rodr_ hola' }], domain ?? '');
    expect(next?.[0].text).toBe('RT: @Julio_Rodr_@x.com hola');
  });

  it('returns null for a body with nothing to change, so it is never written', () => {
    // The property that keeps the run cheap and an interrupted run resumable —
    // and that stops it touching millions of untouched documents.
    expect(qualifyVariants([{ text: 'sin handles aquí' }], 'x.com')).toBeNull();
    expect(qualifyVariants([{ text: 'ya está @alice@mastodon.social' }], 'x.com')).toBeNull();
  });

  it('is idempotent, so a re-run writes nothing', () => {
    const once = qualifyVariants([{ text: 'CTO @openai' }], 'x.com');
    expect(once?.[0].text).toBe('CTO @openai@x.com');
    expect(qualifyVariants(once ?? [], 'x.com')).toBeNull();
  });

  it('qualifies EVERY language variant, not just the primary', () => {
    // Variants are the only home for a post's body; repairing variants[0] alone
    // would leave a translated rendition carrying the bare handle forever.
    const next = qualifyVariants(
      [{ source: 'author', text: 'hola @a' }, { source: 'author', text: 'hello @a' }],
      'x.com',
    );
    expect(next?.map((v) => v.text)).toEqual(['hola @a@x.com', 'hello @a@x.com']);
  });

  it('leaves a variant with no text field untouched rather than throwing', () => {
    const next = qualifyVariants([{ source: 'author' }, { text: 'hi @a' }], 'x.com');
    expect(next?.[0]).toEqual({ source: 'author' });
  });

  it('changes nothing when the actor has no resolvable identity domain', () => {
    // The script skips these rather than guessing a domain; an empty domain must
    // be a no-op and never write a trailing `@`.
    expect(identityDomainOfActor({ networkAcct: undefined, domain: undefined })).toBeUndefined();
    expect(qualifyVariants([{ text: 'hola @a' }], '')).toBeNull();
  });
});
