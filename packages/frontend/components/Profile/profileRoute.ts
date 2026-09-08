import type { Href } from 'expo-router';
import { getNormalizedUserHandle, type AccountKind, type UserHandleInput } from '@oxyhq/core';

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
 * One of an account's SUB-surfaces, under whichever family it belongs to.
 *
 * The sub-routes are the reason this is a function rather than two string
 * literals at each call site: `about` exists under both families, so every
 * caller has to answer "which one am I on" and getting it wrong is invisible —
 * `/@channel/about` renders perfectly well, it is simply a URL that account does
 * not own.
 */
export function profileSubPath(
  family: ProfileRouteFamily,
  handle: string,
  subpath: string,
): Href {
  return family === 'channel' ? `/c/${handle}/${subpath}` : `/@${handle}/${subpath}`;
}

/**
 * The account a link points AT, as every list row, post header and avatar in the
 * app already holds it.
 *
 * Deliberately structural rather than `User`: the shapes that reach these call
 * sites are a post's author DTO, a notification actor, a starter-pack member and
 * half a dozen others, and they agree on exactly these fields. Widening to the
 * full `User` would force a cast at every call site, which is the thing this
 * exists to remove.
 */
export interface ProfileLinkTarget extends UserHandleInput {
  /** Absent on most DTOs; when present it is what sends a channel to `/c/`. */
  kind?: AccountKind;
}

/**
 * Where tapping this account should go — the ONE answer, for every surface that
 * links to a profile.
 *
 * It exists because the alternative was thirty-odd call sites each writing the
 * same three lines: read the handle off the account, bail when there is none,
 * and concatenate `/@` in front of it. Three lines is small enough that nobody
 * noticed they were also each deciding, silently and identically, that the
 * account is a PERSON — so a channel reached from a post row went to `/@handle`
 * and bounced through {@link canonicalProfileHref}'s redirect to arrive where it
 * belonged. Here the family is read from the account's own `kind`, once, and the
 * redirect stays for the DTOs that carry no kind at all.
 *
 * `null` when the account names no usable handle — a federated author whose
 * actor has not resolved yet, or the degraded placeholder the feed renders when
 * Oxy is unreachable. Callers render a non-tappable row rather than a link to
 * nowhere; `if (!href) return;` is the whole contract.
 */
export function profileHrefForUser(
  user: ProfileLinkTarget | null | undefined,
  subpath?: string,
): Href | null {
  const handle = getNormalizedUserHandle(user);
  if (!handle) return null;
  const family = profileRouteFamilyForKind(user?.kind);
  return subpath ? profileSubPath(family, handle, subpath) : profileBasePath(family, handle);
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
  /**
   * The sub-surface the reader is on (`'about'`, …), so a wrong-family SUB-route
   * lands on its counterpart rather than dumping the reader on the profile root.
   *
   * It is carried through the redirect rather than dropped because losing it is
   * itself a bug report: somebody taps "Joined" and arrives at the top of a
   * profile they were already looking at, which reads as a dead link.
   */
  subpath?: string;
}): Href | null {
  if (!params.resolved || !params.handle) return null;
  const target = profileRouteFamilyForKind(params.kind);
  if (target === params.routedFamily) return null;
  return params.subpath
    ? profileSubPath(target, params.handle, params.subpath)
    : profileBasePath(target, params.handle);
}
