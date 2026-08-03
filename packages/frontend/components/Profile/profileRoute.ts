import type { Href } from 'expo-router';
import type { AccountKind } from '@oxyhq/core';

/**
 * Which URL family a profile page belongs to.
 *
 * A channel account's page is `/c/<handle>`, everybody else's is `/@<handle>`.
 * The two are never interchangeable, and the ACCOUNT's own kind is the only
 * thing that decides which — nothing about the URL a reader arrived on does.
 */
export type ProfileRouteFamily = 'channel' | 'person';

/** The family the account itself belongs to. An absent kind reads as a person. */
export function profileRouteFamilyForKind(kind: AccountKind | undefined): ProfileRouteFamily {
  return kind === 'channel' ? 'channel' : 'person';
}

/** The route a given family serves a handle at. */
export function profileBasePath(family: ProfileRouteFamily, handle: string): Href {
  return family === 'channel' ? `/c/${handle}` : `/@${handle}`;
}

/**
 * Where a reader sitting on `routedFamily` for this account should actually be,
 * or `null` when they are already there.
 *
 * This is the ONE canonicalization, deliberately shared by both screens rather
 * than implemented in each. Two screens each deciding where to redirect is how a
 * bounce loop gets built: it takes only one disagreement about what an absent
 * `kind` means for `/c/x` to send to `/@x` while `/@x` sends back. Here there is
 * a single rule and a single reading of `kind`, so "already canonical" and "go
 * there" are answered by the same expression — see the fixed-point test.
 *
 * It is a CANONICALIZATION, not a gate: the kind is only knowable once the
 * account has resolved, so both URLs are legitimately reachable and whichever
 * one a reader arrives on, the one they end up sitting on is the one that
 * account owns. Both directions matter — a post row links every author to
 * `/@<handle>` (the DTO says nothing about account kind), so that is how a
 * reader reaches a channel at all.
 *
 * Returns `null` while the account is unresolved: redirecting on a guess would
 * bounce every channel through `/@` on each cold load.
 */
export function canonicalProfileHref(params: {
  routedFamily: ProfileRouteFamily;
  kind: AccountKind | undefined;
  /** Resolved, never the raw URL segment — the redirect target must be canonical. */
  handle: string;
  /** False while the account is still resolving. */
  resolved: boolean;
}): Href | null {
  if (!params.resolved || !params.handle) return null;
  const target = profileRouteFamilyForKind(params.kind);
  if (target === params.routedFamily) return null;
  return profileBasePath(target, params.handle);
}
