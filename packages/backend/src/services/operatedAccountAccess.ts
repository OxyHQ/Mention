import {
  PublishAsAccessError,
  assertCanPublishAsAccount,
  type AccountMemberReader,
} from './publishAsAccount';
import { logger } from '../utils/logger';

/**
 * Whether `callerId` OPERATES the account `targetOxyUserId` — the question every
 * self-directed moderation refusal actually wants to ask.
 *
 * The one the code used to ask was "is this account me?", which is the whole
 * truth only for a personal login. A channel, organization, project or bot is
 * never the viewer's own id, and yet the viewer may speak with its voice; the id
 * comparison answers "no" for all four and lets somebody block or report an
 * account they publish as. "Is it me" is ONE CASE of "do I operate it", not a
 * synonym for it, and this function is the general form — `assertCanPublishAsAccount`
 * returns success for `target === callerId` before it looks anything up, so the
 * self case falls out of the same authority rather than needing a second branch.
 *
 * ONE AUTHORITY, DELIBERATELY. It reuses {@link assertCanPublishAsAccount}
 * verbatim rather than reading the account graph again, for the same reason
 * `postManagementAccess` does: a second membership reader is a second answer, and
 * whichever of the two is wrong, one of them is wrong in the permissive
 * direction. That inheritance also settles the question this module would
 * otherwise have to invent an answer to — WHICH members count — with the answer
 * the server already enforces everywhere else:
 *
 *  - a **channel**: any ACTIVE member, because a channel can never be acted as,
 *    so membership is the strongest right there is over it;
 *  - an **act-as-eligible** account (organization / project / bot): an active
 *    member holding `account:act_as`, because speaking as it is the same claim of
 *    identity as being it;
 *  - a **personal** account that is not the caller: never, whoever asks.
 *
 * COST. Nothing is asked of Oxy for the two cases that dominate: the target is
 * the caller (returns before any lookup), or the target is an ordinary personal
 * account (refused off the cached identity read, before the member list). Only a
 * managed account reaches the account-graph call, and only on an action a person
 * initiated.
 *
 * ## It fails toward ALLOWING the action, which inverts the module it calls
 *
 * `assertCanPublishAsAccount` fails CLOSED — an unresolvable membership refuses
 * the publish — and that is right there, because publishing as an account is a
 * CAPABILITY: granting one you cannot verify puts words in somebody else's mouth.
 *
 * Block, report and mute are the opposite kind of decision. They are PROTECTIVE,
 * and the caller is usually the person needing protection. So the two errors are
 * not comparable here either, but they land the other way round:
 *
 *  - Wrongly deciding "operates" refuses somebody the only tool they have for
 *    getting away from an account that is abusing them, for as long as Oxy is
 *    unreachable. There is no workaround and no way for them to tell why.
 *  - Wrongly deciding "does not operate" lets an operator do something pointless
 *    to their own account, which the UI did not offer them and which they can
 *    undo.
 *
 * So every refusal, every outage and every unexpected failure reads as `false`
 * (not an operator, action allowed). The guarantee this buys is deliberately the
 * honest one: you cannot act against an account we can POSITIVELY CONFIRM you
 * operate. The frontend fails in the same direction for the same reason, so the
 * button and the route agree about what an unknown answer means.
 */
export async function viewerOperatesAccount(params: {
  targetOxyUserId: string | null | undefined;
  callerId: string | null | undefined;
  memberReader: AccountMemberReader | undefined;
}): Promise<boolean> {
  const target = params.targetOxyUserId?.trim();
  const callerId = params.callerId?.trim();
  // An absent target is NOT an operated account. Spelled out because the module
  // this delegates to reads an absent target as "publish as yourself" and answers
  // SUCCESS — the right answer to its question and the wrong one to this one.
  if (!target || !callerId) return false;

  try {
    await assertCanPublishAsAccount({
      publishAsOxyUserId: target,
      callerId,
      memberReader: params.memberReader,
    });
    return true;
  } catch (error) {
    // Every refusal it can raise — not a member, no `account:act_as`, an account
    // nothing can be published as, and the 503 that means Oxy could not answer —
    // means the same thing here: we cannot confirm this caller operates the
    // account, so the protective action goes ahead. Logged rather than swallowed,
    // since a 503 is an outage somebody should see.
    if (error instanceof PublishAsAccessError) {
      if (error.status === 503) {
        logger.warn('[operatedAccountAccess] Could not verify operator status; allowing', {
          status: error.status,
        });
      }
      return false;
    }
    // Nothing else is expected: the module converts its own member-read failures
    // into a 503 and its kind lookup is fail-soft. Allowing rather than throwing
    // keeps an unexpected fault from turning into "nobody can file a report".
    // `{ error }`, not a bare `error`: on the backend logger `warn` merges its
    // second argument as pino CONTEXT, so an unwrapped Error lands where a context
    // object was expected.
    logger.warn('[operatedAccountAccess] Unexpected failure verifying operator status', {
      error,
    });
    return false;
  }
}
