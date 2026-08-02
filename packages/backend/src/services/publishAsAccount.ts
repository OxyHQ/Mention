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

import type { AccountMember } from '@oxyhq/core';
import { resolveUserSummaries } from './PostHydrationService';
import { logger } from '../utils/logger';

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
 * Whether this Oxy account is a channel.
 *
 * Resolved through {@link resolveUserSummaries} — the SAME Redis-cached identity
 * path post hydration already fills for every author it renders — so the hot
 * paths that ask (the reply gate, on every reply) cost a batched Redis read
 * rather than an Oxy round trip.
 *
 * Fail-soft to `false`: the callers each decide what to do with "not a channel",
 * and each documents why that direction is the safe one for them.
 */
export async function isChannelAccount(
  oxyUserId: string | null | undefined,
): Promise<boolean> {
  if (!oxyUserId) return false;
  try {
    const summaries = await resolveUserSummaries([oxyUserId]);
    return summaries.get(oxyUserId)?.user.kind === 'channel';
  } catch (error) {
    logger.warn('[publishAsAccount] Failed to resolve account kind', error);
    return false;
  }
}

/**
 * Refuse unless `callerId` may publish as `publishAsOxyUserId`.
 *
 * Returns the account the post will be AUTHORED BY: `publishAsOxyUserId` when one
 * was asked for and allowed, otherwise the caller. Callers use the return value
 * rather than re-deriving it, so the authorization and the authorship cannot
 * disagree.
 *
 * Free when nothing was asked for — no query, which is the overwhelming majority
 * of posts. Naming your OWN account is treated as naming none: it is the same
 * post either way, and a membership lookup against a personal account would be
 * asking Oxy a question with no bearing on the answer.
 *
 * The refusals:
 *  - **400** — the target is not a `channel` account. Publishing as an
 *    organization/project/bot is the SESSION SWITCH (`account:act_as`), which
 *    mints a real session for it; a second mechanism for the same thing is how
 *    the two drift. A channel is the case that cannot use it — `isActAsEligibleKind`
 *    refuses a channel, because it is a content identity rather than a seat.
 *  - **403** — no client to ask with (an unauthenticated or MCP caller), or the
 *    caller is not an ACTIVE member of that account.
 *  - **503** — Oxy could not answer. See the module docstring on failing closed.
 */
export async function assertCanPublishAsAccount(params: {
  publishAsOxyUserId: string | null | undefined;
  callerId: string | null | undefined;
  memberReader: AccountMemberReader | undefined;
}): Promise<string | null> {
  const target = params.publishAsOxyUserId?.trim();
  const callerId = params.callerId ?? null;
  if (!target || target === callerId) return callerId;

  if (!callerId) {
    throw new PublishAsAccessError(403, 'You cannot publish as another account');
  }
  if (!(await isChannelAccount(target))) {
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

  const isMember = members.some(
    (member) => member.memberUserId === callerId && member.status === 'active',
  );
  if (!isMember) {
    throw new PublishAsAccessError(403, 'You are not a member of that account');
  }

  return target;
}
