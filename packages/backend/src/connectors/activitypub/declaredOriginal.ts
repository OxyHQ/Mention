import { asRecord } from './helpers';

/**
 * AN OBJECT SAYING, IN THE DOCUMENT, WHICH POST IT IS A COPY OF.
 *
 * The strongest cross-post evidence there is, and the only one that needs no
 * heuristic at all: the source states the relation, so nothing is inferred from
 * timing, text or media. When it is present,
 * `services/PostEquivalenceService` uses it and checks nothing else.
 *
 * ## Where it lives on the wire
 *
 * ActivityStreams 2.0's `url` may be a single string, an object, or an ARRAY of
 * `Link`s, and a `Link` carries `rel`. That is the one standard place an object
 * can name another address for itself and say what the relation is, so a `Link`
 * whose `rel` includes `canonical` (or `original`) is read as this declaration.
 * `href` is where the address lives; a `Link` without one declares nothing.
 *
 * ## What is deliberately NOT read
 *
 * `url` entries with no `rel`, and the plain-string form. Those are the object's
 * OWN address — every Note has one — and reading them as a cross-post
 * declaration would make every post a declared copy of itself.
 *
 * Links in the BODY. A creator linking their other post is a normal thing to do
 * inside a sentence, and it is not a statement that the two are one piece of
 * writing. The weaker `canonical-link` tier considers body links, deliberately
 * beneath this one and with the rest of its conditions attached.
 *
 * ## It returns an empty array far more often than not
 *
 * Nothing in the fediverse emits this today as a matter of course, and that is
 * the expected state rather than a gap to work around: the tiers below it exist
 * precisely because the deterministic signal is usually absent. An empty result
 * is a refusal to guess, not a failure.
 */

/** `rel` tokens that make a `url` entry a declaration about another post. */
const CANONICAL_RELS: ReadonlySet<string> = new Set(['canonical', 'original']);

function relTokens(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/\s+/).map((token) => token.toLowerCase());
  if (Array.isArray(value)) {
    return value.flatMap((entry) => (typeof entry === 'string' ? relTokens(entry) : []));
  }
  return [];
}

/** Every URL an AS2 object declares as its canonical/original elsewhere. */
export function declaredOriginalUrls(object: Record<string, unknown>): string[] {
  const raw = object.url;
  const entries = Array.isArray(raw) ? raw : [raw];
  const urls: string[] = [];

  for (const entry of entries) {
    const link = asRecord(entry);
    if (!link) continue;
    const href = link.href;
    if (typeof href !== 'string' || href.length === 0) continue;
    if (!relTokens(link.rel).some((token) => CANONICAL_RELS.has(token))) continue;
    if (!urls.includes(href)) urls.push(href);
  }

  return urls;
}
