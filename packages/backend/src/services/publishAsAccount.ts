/**
 * The ONE definition of "may this person publish as that account", of "may this
 * person DELETE that account", of "may this person MODERATE that community", and
 * of "is that account a channel" (or a community hosted here).
 *
 * The first two live together because they share the access READ, not
 * because they share an answer — they deliberately do not. Publishing as a
 * channel asks for membership; deleting one asks for `account:delete`, the
 * permission Oxy itself gates the account archive on. A second reader for the
 * second question would be a second answer, and whichever of the two were wrong,
 * one of them would be wrong in the permissive direction.
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
 *  - A **channel** can never be acted as (`isDelegatedActAsEligibleKind` refuses it: it is
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
 * The permissions are READ off Oxy's answer rather than inferred from a role
 * name — a role list here would be a second copy of Oxy's role→permission map,
 * free to drift the moment a role is added or its grants change.
 *
 * WHY THE CALLER'S OWN ACCESS, AND NOT THE SERVICE CREDENTIAL.
 * Every gate here asks `oxy.accountAccessFor(req, accountId)`, which reads
 * `GET /accounts/:id` with the request's OWN verified bearer. Oxy resolves the
 * person's EFFECTIVE access in that account — a direct membership, or one
 * INHERITED from an ancestor account (an organization's member reaching its
 * channel), with per-member grants and revokes applied. Oxy, not Mention,
 * decides. A request with no person session (anonymous, MCP, a capability
 * ticket or a service token) has no access to ask about, so the gate refuses.
 *
 * IT FAILS CLOSED, AND AN OUTAGE IS NOT A "NO". The SDK maps Oxy's answer one
 * way (`accessErrorStatus`): 401 means the session is gone, 403/404 is Oxy's
 * definitive refusal, anything else is UNAVAILABLE (503). Refusing during an
 * outage publishes a post nobody can see until it ends, while allowing would
 * publish a post UNDER ANOTHER ACCOUNT'S IDENTITY that the caller may have no
 * right to — so an unresolvable answer refuses, with a status that says "try
 * again" rather than "you are not a member". Nothing negative is cached: the
 * SDK keeps positive answers only, and these gates ask `fresh` every time.
 */

import type { AccountKind } from '@oxy.so/contracts';
import { isDelegatedActAsEligibleKind } from '@oxy.so/contracts';
import type { AccountMember, AccountNode } from '@oxy.so/core';
import { accessErrorStatus, OxyAccessError, type OxyAccountAccess } from '@oxy.so/core/server';
import type { PostUser } from '@mention/shared-types';
import { isMentionChannel, isMentionCommunity } from '@mention/shared-types/profileUrls';
import { resolveUserSummaries } from './PostHydrationService';
import { logger } from '../utils/logger';

/**
 * The Oxy account permission that authorises assuming an account's identity —
 * what `POST /accounts/:id/switch` gates on, and therefore what publishing under
 * that account's name gates on too.
 *
 * A literal because it is a WIRE value: Oxy derives each member's `permissions`
 * from their role server-side and ships the resulting strings, and neither
 * `@oxy.so/contracts` nor `@oxy.so/core` exports the permission vocabulary today.
 * Its eventual home is `@oxy.so/contracts` beside `ACCOUNT_KINDS`; until then this
 * is one named constant rather than a string scattered through the checks.
 */
const ACCOUNT_ACT_AS_PERMISSION = 'account:act_as';

/**
 * The Oxy account permission that authorises DESTROYING an account — what
 * `DELETE /accounts/:id` gates on (`requireAccountPermission('account:delete')`
 * in oxy-api's `routes/accounts.ts`), and therefore what destroying that
 * account's content in Mention gates on too.
 *
 * Oxy grants it to the `owner` role ALONE: its `ROLE_PERMISSIONS` map gives
 * `admin` and `editor` `account:act_as` without it, so the people who may publish
 * as a channel are strictly wider than the people who may end it. Matching that
 * here is not a preference — a member who could destroy every post while being
 * refused the account archive would produce exactly the half-deleted channel the
 * ordering elsewhere exists to prevent.
 *
 * A literal for the same reason as {@link ACCOUNT_ACT_AS_PERMISSION}: Oxy derives
 * each member's `permissions` from their role server-side and ships the strings,
 * and neither `@oxy.so/contracts` nor `@oxy.so/core` exports the vocabulary today.
 */
const ACCOUNT_DELETE_PERMISSION = 'account:delete';

/**
 * The Oxy account permission every role carries (`owner` through `viewer`):
 * what being a member of an account means in Oxy's vocabulary. A `channel` or a
 * `community` can never be acted as, so there is no stronger right to ask for
 * over one — writing for it, or moderating it, IS being one of its members.
 */
const ACCOUNT_READ_PERMISSION = 'account:read';

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
 * The caller's effective access in one Oxy account: `oxy.accountAccessFor`
 * bound to ONE request (`callerAccountAccess` in `utils/oxyHelpers`). A function
 * rather than the request itself, so a gate can only ask about access and
 * nothing else is implied about what it may do. It rejects with
 * `OxyAccessError`, which {@link readCallerAccess} maps to a status.
 */
export type AccountAccessReader = (accountId: string) => Promise<OxyAccountAccess>;

/**
 * The INVERSE read: every account this caller can reach, rather than one named
 * account's access. Separate interface for the same reason as
 * {@link AccountAccessReader} — a caller hands over a client that can enumerate
 * its own forest and nothing more is implied.
 *
 * Also authorized against the caller's OWN bearer: `GET /accounts` is anchored on
 * the authenticated operator, so a service credential cannot ask it "which
 * accounts does person X operate" at all. That is the whole reason the notifying
 * side of a channel is resolved at READ time (see {@link listOperatedChannelIds}).
 */
export interface OperatedAccountReader {
  accounts: {
    list(): Promise<AccountNode[]>;
  };
}

/**
 * Whether a set of EFFECTIVE account permissions authorises its holder to act
 * FOR an account of this kind — the one predicate behind every question this
 * module answers ("may this person publish as that account", "which accounts
 * does this person operate"), so they can never drift into disagreeing about
 * the same person.
 *
 * The two families are graded differently, and the module docstring says why:
 * membership (`account:read`, which every role holds) is the whole right over a
 * `channel` (nothing stronger exists, since a channel can never be acted as),
 * while a delegation-eligible account demands `account:act_as`. Human account
 * switching is a separate, narrower question that excludes bots. A kind that is
 * neither family answers `false`.
 */
function permissionsAuthorizeActingFor(
  kind: AccountKind | null | undefined,
  has: (permission: string) => boolean,
): boolean {
  if (kind === 'channel') return has(ACCOUNT_READ_PERMISSION);
  if (!isDelegatedActAsEligibleKind(kind)) return false;
  return has(ACCOUNT_ACT_AS_PERMISSION);
}

/** {@link permissionsAuthorizeActingFor} over the caller's access Oxy resolved for one account. */
export function accessAuthorizesActingFor(
  kind: AccountKind | null | undefined,
  access: OxyAccountAccess,
): boolean {
  return permissionsAuthorizeActingFor(kind, (permission) => access.has(permission));
}

/**
 * {@link permissionsAuthorizeActingFor} over the `callerMembership` an account
 * LIST carries (`GET /accounts`, Oxy's effective membership, inherited rows
 * included). Every "no" is a refusal rather than an assumption: a missing row, a
 * membership that is `invited`/`removed` rather than `active`, and an absent or
 * malformed `permissions` array all answer `false`.
 */
export function membershipAuthorizesActingFor(
  kind: AccountKind | null | undefined,
  membership: AccountMember | null | undefined,
): boolean {
  if (!membership || membership.status !== 'active') return false;
  const permissions = Array.isArray(membership.permissions) ? membership.permissions : [];
  return permissionsAuthorizeActingFor(kind, (permission) => permissions.includes(permission));
}

/**
 * The CHANNEL accounts this caller operates — the recipient set for a channel's
 * notifications (`services/notificationInbox`).
 *
 * WHY THIS EXISTS AS THE INVERSE OF THE GATE ABOVE. A channel has no session
 * (`isDelegatedActAsEligibleKind` refuses it), so a notification addressed to one is
 * addressed to a mailbox nobody can open. The humans who can act on it are its
 * members — but nothing server-side can ask Oxy "who are the members of channel
 * C": `GET /accounts/:id/members` is authorized against the CALLER, and the
 * notification fan-out has no caller. `GET /accounts` inverts exactly that
 * limitation: asked with a reader's own bearer it returns the accounts THEY
 * reach, each carrying `callerMembership` — the authorization answer and the
 * account list in one call, with no second membership read.
 *
 * **Filtered to `channel` deliberately, not to "every account I operate".** An
 * organization / project / bot can be delegated, so their notifications belong
 * to the effective account session or service lane rather than being fanned out
 * to every member. That authority requires `account:act_as`, which a `viewer` or
 * `billing` member does not hold. Widening this to those kinds would hand the
 * refused view to exactly those members through a separate notification path.
 *
 * Both this set and {@link assertCanPublishAsAccount} read Oxy's EFFECTIVE
 * access — `callerMembership` here, `accountAccessFor` there — so an inherited
 * member is a member to both.
 *
 * Fail-soft to `[]`. The caller ({@link resolveNotificationInboxIds}) still reads
 * its own notifications, so an Oxy outage degrades a channel operator to the
 * inbox they had before this existed rather than 500-ing the notifications
 * screen — and it can never ADD a recipient, which is the direction that would
 * matter.
 */
export async function listOperatedChannelIds(
  reader: OperatedAccountReader | undefined,
): Promise<string[]> {
  if (!reader) return [];
  let accounts: AccountNode[];
  try {
    accounts = await reader.accounts.list();
  } catch (error) {
    logger.warn('[publishAsAccount] Failed to list operated accounts', error);
    return [];
  }
  return accounts
    .filter(
      (node) =>
        node.kind === 'channel' && membershipAuthorizesActingFor(node.kind, node.callerMembership),
    )
    .map((node) => node.accountId)
    .filter((accountId): accountId is string => Boolean(accountId));
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
  for (const [id, account] of await resolveAccounts(oxyUserIds)) {
    if (account.kind) kinds.set(id, account.kind);
  }
  return kinds;
}

/**
 * The Oxy accounts behind several ids, through the cached identity path, and
 * fail-soft to an empty map — the one read under {@link resolveAccountKinds} and
 * {@link isChannelAccount}.
 */
async function resolveAccounts(
  oxyUserIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, PostUser>> {
  const accounts = new Map<string, PostUser>();
  const ids = [...new Set(oxyUserIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return accounts;
  try {
    const summaries = await resolveUserSummaries(ids);
    for (const id of ids) {
      const user = summaries.get(id)?.user;
      if (user) accounts.set(id, user);
    }
  } catch (error) {
    logger.warn('[publishAsAccount] Failed to resolve account kinds', error);
  }
  return accounts;
}

/**
 * Whether this Oxy account is a Mention channel — the question
 * `utils/channelReplyGate` asks about a post's author, on every reply.
 *
 * `isMentionChannel`, so a REMOTE account Oxy records as `channel` (a PeerTube
 * channel) is not one: its posts take the comments its own server accepts.
 *
 * Fail-soft to `false`, deliberately: see that module on why an unresolvable
 * author must read as not-a-channel rather than refusing every reply on the site
 * for the duration of an identity outage.
 */
export async function isChannelAccount(oxyUserId: string | null | undefined): Promise<boolean> {
  if (!oxyUserId) return false;
  return isMentionChannel((await resolveAccounts([oxyUserId])).get(oxyUserId));
}

/** What each outcome of an access read is answered with. */
const ACCESS_REFUSALS: Record<401 | 403 | 404 | 503, string> = {
  401: 'Sign in again to act for that account',
  403: 'You are not a member of that account',
  404: 'You are not a member of that account',
  503: 'Could not verify your access to that account',
};

/**
 * The caller's effective access in an account, or a refusal.
 *
 * The ONE access read behind every gate this module answers, factored so the
 * publish gate, {@link assertCanDeleteAccount} and
 * {@link assertCanModerateCommunity} cannot come to different conclusions about
 * who a caller is on an account — a second read is a second answer, and
 * whichever of the two is wrong, one of them is wrong in the permissive
 * direction. What each caller then DEMANDS of the access is their own decision.
 *
 * `accessErrorStatus` is the SDK's one mapping: 401 (session gone), 403 (Oxy
 * refused, 404 included), 503 (Oxy could not answer). Anything that is not an
 * `OxyAccessError` is unexpected, and refuses as 503 too: fail closed.
 */
async function readCallerAccess(
  target: string,
  accountAccess: AccountAccessReader,
): Promise<OxyAccountAccess> {
  try {
    return await accountAccess(target);
  } catch (error) {
    const status = error instanceof OxyAccessError ? accessErrorStatus(error) : 503;
    if (status === 503) {
      logger.warn("[publishAsAccount] Could not read the caller's account access", {
        code: error instanceof OxyAccessError ? error.code : 'unexpected',
      });
    }
    throw new PublishAsAccessError(status, ACCESS_REFUSALS[status]);
  }
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
 *  - **401** — Oxy refused the caller's session: sign in again.
 *  - **403** — no person to ask about (an unauthenticated, MCP or capability
 *    caller), Oxy says the caller has no access in that account, or — for an
 *    act-as-eligible account — their access lacks `account:act_as`.
 *  - **503** — Oxy could not answer. See the module docstring on failing closed.
 */
export async function assertCanPublishAsAccount(params: {
  publishAsOxyUserId: string | null | undefined;
  callerId: string | null | undefined;
  accountAccess: AccountAccessReader | undefined;
}): Promise<PublishAsAuthor> {
  const target = params.publishAsOxyUserId?.trim();
  const callerId = params.callerId ?? null;
  if (!target || target === callerId) return { authorId: callerId, authorKind: null };

  if (!callerId) {
    throw new PublishAsAccessError(403, 'You cannot publish as another account');
  }

  // WHICH authority this account answers to, decided before anything is asked of
  // Oxy about the caller's access. A named predicate rather than a `kind !== 'personal'`
  // test on purpose: a kind Oxy adds later is handled by it instead of silently
  // inheriting whichever branch a local list happened to put it in.
  //
  // It is NOT the predicate the session switch gates on, and that used to be the
  // stated reason for choosing it. Oxy split the two questions: a person may
  // switch into an `organization` or `project` only, while an application may be
  // DELEGATED to act as a `bot` as well — which is a bot's whole purpose.
  // Publishing as an account is the delegation question, so this is the right
  // half of the split; it simply no longer matches the switch.
  const authorKind = await resolveAccountKind(target);
  const requiresActAs = isDelegatedActAsEligibleKind(authorKind);
  if (authorKind !== 'channel' && !requiresActAs) {
    throw new PublishAsAccessError(400, 'That account cannot be published as');
  }

  if (!params.accountAccess) {
    throw new PublishAsAccessError(403, 'You cannot publish as another account');
  }

  const access = await readCallerAccess(target, params.accountAccess);

  // The permission is READ off the access Oxy resolved, never inferred from
  // `access.role` — a role list here would be a second copy of Oxy's
  // role→permission map, and the copy is what goes stale.
  //
  // Answered by the SHARED predicate rather than inline, so this gate and
  // `listOperatedChannelIds` cannot come to different conclusions about the same
  // person and the same account.
  if (!accessAuthorizesActingFor(authorKind, access)) {
    throw new PublishAsAccessError(403, 'You cannot publish as that account');
  }

  return { authorId: target, authorKind };
}

/**
 * Refuse unless `callerId` may DELETE the account `targetOxyUserId`, and answer
 * with the kind Oxy resolved for it.
 *
 * ## Why this is not {@link assertCanPublishAsAccount} with a different message
 *
 * That gate grades a `channel` at bare ACTIVE MEMBERSHIP, and correctly: a
 * channel can never be acted as, so over a channel there is no capability
 * stronger than membership to ask for. Deletion is the exception, because the
 * stronger right exists and lives at Oxy. `DELETE /accounts/:id` gates on
 * `account:delete`, which oxy-api's `ROLE_PERMISSIONS` grants to `owner` alone —
 * `admin` and `editor` hold `account:act_as` and not this. So the set of people
 * who may publish as a channel is strictly WIDER than the set who may end it.
 *
 * Deleting a channel is two halves that answer to two authorities: Mention
 * destroys its own rows, Oxy archives the account. If Mention accepted a mere
 * member here, an `editor` could destroy every post the channel has published and
 * then be refused the archive by Oxy — a channel with no content, no way to undo
 * it, and an account still standing. Asking for the SAME permission Oxy asks for
 * is what makes the two halves either both permitted or both refused.
 *
 * ## The refusals
 *
 *  - **400** — the account's kind could not be resolved at all. Deleting an
 *    account whose kind is unknown is the risk `ChannelDeletionService` already
 *    refuses to take at its own door, and this is the same judgement made one
 *    layer earlier, before the caller's access is even read.
 *  - **401** — Oxy refused the caller's session: sign in again.
 *  - **403** — no caller, no person to ask about (an unauthenticated, MCP or
 *    capability caller), Oxy says the caller has no access, or their access
 *    lacks `account:delete`.
 *  - **503** — Oxy could not answer. It fails closed for the reason in the module
 *    docstring, and here the argument is at its strongest: the action is
 *    irreversible, so a refusal costs a retry and a wrong allow costs an archive.
 *
 * The kind is RETURNED rather than checked here, because "may this person delete
 * that account" and "is that account a thing Mention knows how to delete" are two
 * questions. The caller answers the second — `ChannelDeletionService` refuses
 * anything that is not a channel at its own entry points, and a route wanting a
 * different status code for that can say so without this gate growing a second
 * opinion.
 */
export async function assertCanDeleteAccount(params: {
  targetOxyUserId: string | null | undefined;
  callerId: string | null | undefined;
  accountAccess: AccountAccessReader | undefined;
}): Promise<AccountKind> {
  const target = params.targetOxyUserId?.trim();
  const callerId = params.callerId?.trim();
  // No self case, deliberately: the accounts this gate governs have no login, so
  // a caller can never BE one. Were a personal account ever routed here, its owner
  // holds `account:delete` through their own membership like anybody else, and a
  // shortcut that skipped the read would be a hole rather than an optimisation.
  if (!target || !callerId) {
    throw new PublishAsAccessError(403, 'You cannot delete that account');
  }

  const kind = await resolveAccountKind(target);
  if (!kind) {
    throw new PublishAsAccessError(400, 'That account cannot be deleted');
  }

  if (!params.accountAccess) {
    throw new PublishAsAccessError(403, 'You cannot delete that account');
  }

  const access = await readCallerAccess(target, params.accountAccess);

  // READ off the access Oxy resolved, never inferred from `access.role` — a role
  // list here would be a second copy of Oxy's role→permission map, and the copy
  // is what goes stale on the day a role's grants change.
  if (!access.has(ACCOUNT_DELETE_PERMISSION)) {
    throw new PublishAsAccessError(403, 'Only an owner of this account can delete it');
  }

  return kind;
}

/**
 * The community hosted here behind `oxyUserId` ({@link isMentionCommunity}), or
 * `null` — for a remote community, any other kind, or an id the identity path
 * could not resolve. Through the same cached identity read as every kind
 * question in this module.
 */
export async function resolveMentionCommunity(
  oxyUserId: string | null | undefined,
): Promise<PostUser | null> {
  if (!oxyUserId) return null;
  return (await resolveMentionCommunities([oxyUserId])).get(oxyUserId) ?? null;
}

/**
 * The COMMUNITIES among several ids — hosted here or remote (a Lemmy, PieFed or
 * Mbin `Group`) alike, by Oxy's kind — in one batched read; misses are absent.
 * Where a post may be written: in a community hosted here Mention is the
 * authority, in a remote one its own server is.
 */
export async function resolveCommunities(
  oxyUserIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, PostUser>> {
  const communities = new Map<string, PostUser>();
  for (const [id, account] of await resolveAccounts(oxyUserIds)) {
    if (account.kind === 'community') communities.set(id, account);
  }
  return communities;
}

/** {@link resolveMentionCommunity} for several ids in one batched read; misses are absent. */
export async function resolveMentionCommunities(
  oxyUserIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, PostUser>> {
  const communities = new Map<string, PostUser>();
  for (const [id, account] of await resolveAccounts(oxyUserIds)) {
    if (isMentionCommunity(account)) communities.set(id, account);
  }
  return communities;
}

/**
 * Refuse unless `callerId` MODERATES the community hosted here
 * `communityOxyUserId`, and answer with the community.
 *
 * A community's moderators are its MEMBERS, whatever their role (direct or
 * inherited) — the same answer Oxy publishes as its moderators collection (`GET
 * /users/:id/moderators`) and the same grading a channel's writers get: a
 * community can never be acted as (`isDelegatedActAsEligibleKind` refuses it),
 * so nothing stronger than membership (`account:read`) exists to ask for. Read
 * through {@link readCallerAccess}, the one access read behind every gate here,
 * with the CALLER's own bearer.
 *
 *  - **404** — not a community hosted here (a remote community is moderated by
 *    its own server, and nothing else has moderators).
 *  - **401** — Oxy refused the caller's session: sign in again.
 *  - **403** — no caller, no person to ask about, or not a member.
 *  - **503** — Oxy could not answer. Fails closed: a moderation action removes
 *    other people's work, so an unverifiable moderator is refused.
 */
export async function assertCanModerateCommunity(params: {
  communityOxyUserId: string | null | undefined;
  callerId: string | null | undefined;
  accountAccess: AccountAccessReader | undefined;
}): Promise<PostUser> {
  const target = params.communityOxyUserId?.trim();
  const callerId = params.callerId?.trim();
  const community = await resolveMentionCommunity(target);
  if (!target || !community) {
    throw new PublishAsAccessError(404, 'Community not found');
  }
  if (!callerId || !params.accountAccess) {
    throw new PublishAsAccessError(403, 'You do not moderate that community');
  }
  const access = await readCallerAccess(target, params.accountAccess);
  if (!access.has(ACCOUNT_READ_PERMISSION)) {
    throw new PublishAsAccessError(403, 'You do not moderate that community');
  }
  return community;
}
