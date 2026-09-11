/**
 * WHICH HANDLE IS A PUBLIC MENTION PROFILE, AND WHICH ONE ONLY *REACHES* ONE.
 *
 * A federated account can be addressed two different ways, and only one of them
 * is an identity:
 *
 *     protocol / transport acct   zuck@kilogram.makeup
 *     canonical network identity  zuck@instagram.com
 *
 * `kilogram.makeup` is the ActivityPub bridge that republishes public Instagram
 * accounts. It is how a post REACHED us — the equivalent of an internal delivery
 * address — and the federation layer legitimately resolves it, because
 * ActivityPub literally addresses actors by those URIs and accts. What it must
 * never be is a SECOND public profile URL: `/@zuck@kilogram.makeup` rendering
 * Zuckerberg's page gives one person two canonical addresses, publishes the
 * bridge hostname as if it were the account's network, and hands search engines
 * and share sheets a link that contradicts the one the profile itself shows.
 *
 * ## The rule, and why it needs no list of bridge hosts
 *
 * `bridgeHost === 'kilogram.makeup'` is the obvious implementation and the wrong
 * one. Which hosts republish which network is a reviewed moderation policy that
 * lives in the backend (`connectors/activitypub/federationBridgePolicy`), and
 * restating any part of it here would give it a second copy to drift from — with
 * the drift landing on THIS side, where a profile that silently 404s is
 * indistinguishable from an account we do not have, so nobody reports it. The
 * next bridge added to that policy would also need a second review nobody would
 * remember to do.
 *
 * So the rule is stated without naming anything: **a federated profile URL must
 * spell the account's own identity.** Oxy stores every federated account under
 * the identity the federation layer derived for it — `zuck@instagram.com` for a
 * relabelled bridge actor, `alice@bsky.social` for an atproto one, plain
 * `user@mastodon.social` for an ordinary instance — and hands that back as the
 * resolved profile's `username`. A routed handle that resolves to a DIFFERENT
 * identity than it spells was therefore a transport address, whatever host it
 * names, and every future bridge inherits the rule for free.
 *
 * ## What this deliberately does not do
 *
 * It does not redirect. A reader who lands on a transport acct gets the
 * not-found surface, because a redirect would keep the transport address alive
 * as a working public URL — bookmarked, shared and indexed — which is the thing
 * being removed. Reader-facing navigation is generated from the canonical
 * identity everywhere already (search rows, author links, mentions), so nothing
 * a reader can CLICK produces one of these; only a hand-typed or historical URL
 * can, and that is exactly the case that should stop working.
 */

/** A handle stripped of its leading `@`s, trimmed and lowercased for comparison. */
function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').trim().toLowerCase();
}

/**
 * Whether `routedHandle` — the `[username]` segment of a `/@<handle>` URL — is
 * the resolved account's own public identity rather than a transport address
 * that merely reaches it.
 *
 * `resolvedUsername` is the `username` of the profile the handle resolved to, as
 * Oxy stores it. An EMPTY or absent one answers `true`: the comparison has
 * nothing to compare, and a resolve that came back without an identity is an
 * unexpected wire shape rather than evidence that the reader typed a transport
 * address. Failing open there keeps an unforeseen backend change from 404ing
 * every federated profile at once; failing closed would hide accounts we hold.
 *
 * Both sides are normalized, so casing and a leading `@` never decide it — a
 * fediverse acct is case-insensitive and Oxy stores it lowercased.
 */
export function isPublicProfileHandle(
  routedHandle: string,
  resolvedUsername: string | null | undefined,
): boolean {
  const canonical = typeof resolvedUsername === 'string' ? normalizeHandle(resolvedUsername) : '';
  if (canonical.length === 0) return true;
  return normalizeHandle(routedHandle) === canonical;
}
