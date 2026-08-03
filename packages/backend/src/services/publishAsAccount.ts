/**
 * The ONE definition of "may this person publish as that account", and of "is
 * that account a channel".
 *
 * A channel is an Oxy ACCOUNT (`kind: 'channel'`), not a Mention row, so both
 * questions are answered by Oxy and Mention stores neither. There is deliberately
 * no membership table here: a second copy of who may publish is a second thing to
 * keep in sync with the account graph, and it would go stale exactly when it
 * matters (a member removed in Oxy would still be publishing here).
 *
 * TWO FAMILIES OF ACCOUNT, TWO DIFFERENT AUTHORITIES — this is the part that is
 * easy to get wrong by collapsing it into one membership test.
 *
 *  - A **channel** can never be acted as (`isActAsEligibleKind` refuses it: it is
 *    a content identity, not a seat). There is no session anybody could switch
 *    into, so there is no stronger right than membership to ask for — acting for
 *    a channel simply IS being one of its members.
 *  - An **act-as-eligible** account (organization / project / bot) CAN be switched
 *    into, and the right that governs that switch is `account:act_as`. Signing a
 *    post as the organization is the same claim of identity as being it for a
 *    session, so it is gated on the same permission. Bare membership is NOT
 *    enough: an account's `viewer`, `billing` and `developer` members are members
 *    who deliberately may not act as it, and letting one of them publish under
 *    its name would hand out through this door exactly what
 *    `POST /accounts/:id/switch` refuses at the other one.
 *
 * `AccountMember.permissions` is derived from the role by Oxy at write time, so
 * the permission is READ rather than inferred from a role name — a role list here
 * would be a second copy of Oxy's role→permission map, free to drift the moment a
 * role is added or its grants change.
 *
 * WHY THE CALLER'S OWN OXY CLIENT, AND NOT THE SERVICE CREDENTIAL.
 * `GET /accounts/:id/members` is gated on the AUTHENTICATED USER's effective
 * `members:read` over that account (`requireAccountPermission` in oxy-api); it
 * does not honour service-token delegation (`X-Oxy-User-Id` is read by
 * `optionalAuth`, which that router does not use). So the check is made with a
 * client built from the caller's own verified bearer, and Oxy — not Mention —
 * decides. A caller with no readable membership gets a 403 from Oxy, which is the
 * same answer this gate would give them anyway.
 *
 * IT FAILS CLOSED. An Oxy outage makes the answer unknowable, and the two
 * directions are not comparable: refusing publishes a post nobody can see until
 * the outage ends, while allowing publishes a post UNDER ANOTHER ACCOUNT'S
 * IDENTITY that the caller may have no right to. So an unresolvable membership is
 * a refusal, not a default.
 */

import type { AccountKind } from '@oxyhq/contracts';
import { isActAsEligibleKind } from '@oxyhq/contracts';
import type { AccountMember } from '@oxyhq/core';
import { resolveUserSummaries } from './PostHydrationService';
import { logger } from '../utils/logger';

/**
 * The Oxy account permission that authorises assuming an account's identity —
 * what `POST /accounts/:id/switch` gates on, and therefore what publishing under
 * that account's name gates on too.
 *
 * A literal because it is a WIRE value: Oxy derives each member's `permissions`
 * from their role server-side and ships the resulting strings, and neither
 * `@oxyhq/contracts` nor `@oxyhq/core` exports the permission vocabulary today.
 * Its eventual home is `@oxyhq/contracts` beside `ACCOUNT_KINDS`; until then this
 * is one named constant rather than a string scattered through the checks.
 */
const ACCOUNT_ACT_AS_PERMISSION = 'account:act_as';

/** A refusal carrying the status the HTTP layer should answer with. */
export class PublishAsAccessError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'PublishAsAccessError';
    this.status = status;
  }
}

/**
 * The one Oxy call this module makes, as an interface rather than the whole
 * `OxyServices` surface — so a caller has to hand over a client that can read a
 * member list and nothing else is implied about what it may do.
 */
export interface AccountMemberReader {
  listAccountMembers(accountId: string): Promise<AccountMember[]>;
}

/**
 * Collapse repeated reads of the SAME account's member list onto one call, for a
 * caller that authorizes several targets in one request (`POST /posts/thread` in
 * beast mode, where every entry may name its own account). Twelve entries naming
 * one organization make one membership call, not twelve.
 *
 * The PROMISE is memoized, not its value, so two concurrent asks for one account
 * share a single in-flight request — and a failure is shared too, which is what
 * makes the batch refuse consistently instead of depending on which entry hit the
 * outage.
 *
 * **Per REQUEST, never module scope.** This holds an authorization answer for one
 * specific caller's bearer; hoisting it would serve one person's membership to
 * the next — the same reason `createUserScopedOxyServices` builds a fresh Oxy
 * client per request.
 */
export function cacheAccountMemberReads(reader: AccountMemberReader): AccountMemberReader {
  const byAccount = new Map<string, Promise<AccountMember[]>>();
  return {
    listAccountMembers(accountId: string): Promise<AccountMember[]> {
      const pending = byAccount.get(accountId);
      if (pending) return pending;
      const started = reader.listAccountMembers(accountId);
      byAccount.set(accountId, started);
      return started;
    },
  };
}

/**
 * The Oxy account `kind` behind an id, or `null` when it cannot be resolved.
 *
 * Resolved through {@link resolveUserSummaries} — the SAME Redis-cached identity
 * path post hydration already fills for every author it renders — so the hot
 * paths that ask (the reply gate, on every reply) cost a batched Redis read
 * rather than an Oxy round trip.
 *
 * Fail-soft to `null`: the callers each decide what an unknown kind means, and
 * each documents why that direction is the safe one for them.
 */
export async function resolveAccountKind(
  oxyUserId: string | null | undefined,
): Promise<AccountKind | null> {
  if (!oxyUserId) return null;
  return (await resolveAccountKinds([oxyUserId])).get(oxyUserId) ?? null;
}

/**
 * The kinds behind SEVERAL ids, in one batched identity read.
 *
 * The single-id form above is the common case (the reply gate asks about one
 * author); this exists because deciding whether a thread link is a channel's
 * asks about two or three accounts at once, and three sequential single reads
 * would be three round trips to answer one question.
 *
 * Ids that do not resolve are ABSENT from the map rather than present with a
 * `null` — so a caller reading a kind off it gets `undefined` and has to decide
 * what an unknown account means, instead of one that silently reads as "not a
 * channel". Fail-soft on error, for the same reason the single form is: see
 * `utils/channelReplyGate` on why an identity outage must not refuse every reply
 * on the site.
 */
export async function resolveAccountKinds(
  oxyUserIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, AccountKind>> {
  const kinds = new Map<string, AccountKind>();
  const ids = [...new Set(oxyUserIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return kinds;
  try {
    const summaries = await resolveUserSummaries(ids);
    for (const id of ids) {
      const kind = summaries.get(id)?.user.kind;
      if (kind) kinds.set(id, kind);
    }
  } catch (error) {
    logger.warn('[publishAsAccount] Failed to resolve account kinds', error);
  }
  return kinds;
}

/**
 * Whether this Oxy account is a channel — the question `utils/channelReplyGate`
 * asks about a post's author, on every reply.
 *
 * Fail-soft to `false`, deliberately: see that module on why an unresolvable
 * author must read as not-a-channel rather than refusing every reply on the site
 * for the duration of an identity outage.
 */
export async function isChannelAccount(
  oxyUserId: string | null | undefined,
): Promise<boolean> {
  return (await resolveAccountKind(oxyUserId)) === 'channel';
}

/** What {@link assertCanPublishAsAccount} answers with. */
export interface PublishAsAuthor {
  /**
   * The account the post is AUTHORED BY — the named account when one was asked
   * for and allowed, otherwise the caller. Callers use this rather than
   * re-deriving it, so the authorization and the authorship cannot disagree.
   */
  authorId: string | null;
  /**
   * That author's Oxy account kind, resolved ONLY when another account was named
   * and allowed; `null` on the ordinary path, where nothing was looked up.
   *
   * It rides along because the ONE resolution that authorized the publish is also
   * the answer every downstream rule keyed on the author's kind needs — today
   * whether the post is persisted `replyPermission: ['nobody']` (a channel takes
   * no replies; an organization is an ordinary account and takes them normally).
   * Returning it is what keeps that rule from re-deriving the kind through a
   * second lookup that could answer differently.
   */
  authorKind: AccountKind | null;
}

/**
 * Refuse unless `callerId` may publish as `publishAsOxyUserId`.
 *
 * Returns {@link PublishAsAuthor}: the account the post will be AUTHORED BY, and
 * that account's kind. Callers use the return value rather than re-deriving it,
 * so the authorization, the authorship and the author-kind rules cannot disagree.
 *
 * Free when nothing was asked for — no query, which is the overwhelming majority
 * of posts. Naming your OWN account is treated as naming none: it is the same
 * post either way, and a membership lookup against a personal account would be
 * asking Oxy a question with no bearing on the answer.
 *
 * The refusals:
 *  - **400** — the target is an account nothing can be published as: a `personal`
 *    account (a human login — authoring as one is impersonation, and its owner is
 *    the only person who can post as it, by signing in), or an id whose kind could
 *    not be resolved at all. An unknown kind refuses because the two directions
 *    are not comparable — see the module docstring on failing closed. Any kind Oxy
 *    adds later is refused until it is deliberately admitted here, rather than
 *    inherited by accident.
 *  - **403** — no client to ask with (an unauthenticated or MCP caller), the
 *    caller is not an ACTIVE member of that account, or — for an act-as-eligible
 *    account — they are a member without `account:act_as`.
 *  - **503** — Oxy could not answer. See the module docstring on failing closed.
 */
export async function assertCanPublishAsAccount(params: {
  publishAsOxyUserId: string | null | undefined;
  callerId: string | null | undefined;
  memberReader: AccountMemberReader | undefined;
}): Promise<PublishAsAuthor> {
  const target = params.publishAsOxyUserId?.trim();
  const callerId = params.callerId ?? null;
  if (!target || target === callerId) return { authorId: callerId, authorKind: null };

  if (!callerId) {
    throw new PublishAsAccessError(403, 'You cannot publish as another account');
  }

  // WHICH authority this account answers to, decided before anything is asked of
  // Oxy's member list. `isActAsEligibleKind` rather than a `kind !== 'personal'`
  // test on purpose: it is the predicate Oxy itself gates the session switch on,
  // so the two can never disagree about what may be assumed.
  const authorKind = await resolveAccountKind(target);
  const requiresActAs = isActAsEligibleKind(authorKind);
  if (authorKind !== 'channel' && !requiresActAs) {
    throw new PublishAsAccessError(400, 'That account cannot be published as');
  }

  if (!params.memberReader) {
    throw new PublishAsAccessError(403, 'You cannot publish as another account');
  }

  let members: AccountMember[];
  try {
    members = await params.memberReader.listAccountMembers(target);
  } catch (error) {
    // Includes Oxy's own 403 for a caller with no `members:read`, which is the
    // same answer as "not a member" — but it is not distinguishable here from a
    // genuine outage, and both must refuse. The status says "try again" because
    // the outage case is the one a client can act on.
    logger.warn('[publishAsAccount] Failed to read account members', error);
    throw new PublishAsAccessError(503, 'Could not verify your access to that account');
  }

  const membership = members.find(
    (member) => member.memberUserId === callerId && member.status === 'active',
  );
  if (!membership) {
    throw new PublishAsAccessError(403, 'You are not a member of that account');
  }

  // The permission is READ off the membership Oxy resolved, never inferred from
  // `membership.role` — a role list here would be a second copy of Oxy's
  // role→permission map, and the copy is what goes stale. An absent or malformed
  // `permissions` array is therefore a refusal, not an assumption.
  if (
    requiresActAs &&
    !(Array.isArray(membership.permissions) && membership.permissions.includes(ACCOUNT_ACT_AS_PERMISSION))
  ) {
    throw new PublishAsAccessError(403, 'You cannot publish as that account');
  }

  return { authorId: target, authorKind };
}
