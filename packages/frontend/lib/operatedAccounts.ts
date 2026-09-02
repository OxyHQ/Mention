import { isDelegatedActAsEligibleKind } from '@oxyhq/contracts';
import type { AccountNode } from '@oxyhq/core';

/**
 * The Oxy account permission that authorises assuming an account's identity, and
 * therefore speaking as it.
 *
 * A wire value: Oxy derives each member's `permissions` from their role
 * server-side and ships the resulting strings. The Mention backend names the same
 * constant in `services/publishAsAccount.ts` for the same reason — neither
 * `@oxyhq/contracts` nor `@oxyhq/core` exports the permission vocabulary yet.
 * When one of them does, both call sites read it from there.
 */
const ACCOUNT_ACT_AS_PERMISSION = 'account:act_as';

/**
 * Whether the caller OPERATES this account — may speak with its voice — read off
 * the membership Oxy already resolved onto the node.
 *
 * This is the frontend half of the rule the backend enforces in
 * `services/publishAsAccount.ts`, and it is deliberately the SAME rule rather
 * than a convenient approximation of it. Two families, two authorities:
 *
 *  - A **channel** can never be acted as, so there is no stronger right to ask
 *    for than membership: an active member operates it.
 *  - A **delegation-eligible** account (organization / project / bot) can have
 *    an application speak for it, so publishing under its name requires
 *    `account:act_as`. An account's `viewer`, `billing` and `developer` members
 *    deliberately do not hold that authority.
 *
 * The permission is READ off `callerMembership.permissions`, which Oxy resolves
 * from the role at write time — never inferred from `callerMembership.role`, which
 * would be a second copy of Oxy's role→permission map and free to drift the moment
 * a role is added.
 *
 * A named predicate rather than `kind !== 'personal'`: a kind Oxy adds later is
 * handled by it instead of silently inheriting whichever branch a local list
 * happened to put it in.
 *
 * It is NOT the predicate the session switch gates on. Oxy split that question in
 * two — a person may switch into an `organization` or `project`, while an
 * application may be delegated to act as a `bot` as well — and speaking with an
 * account's voice is the delegation half.
 *
 * **An absent `callerMembership` reads as NOT operated**, even though the node
 * appearing in the caller's own account list implies some access. `AccountNode`
 * documents `null` as covering both "ownership is implicit" (their own personal
 * root) and "the caller has no membership", and those want opposite answers — so
 * the ambiguous value takes the direction that keeps a safety affordance
 * available. The one case it gives up, a personal root, is answered exactly and
 * for free by comparing ids, which is what {@link useOperatesAccount}'s callers
 * already do.
 */
export function operatesAccountNode(node: AccountNode): boolean {
  const membership = node.callerMembership;
  if (!membership || membership.status !== 'active') return false;
  if (!isDelegatedActAsEligibleKind(node.kind)) return true;
  return (
    Array.isArray(membership.permissions) &&
    membership.permissions.includes(ACCOUNT_ACT_AS_PERMISSION)
  );
}

/**
 * Whether `accountId` is one of the accounts in `nodes` that the caller operates.
 *
 * `nodes` being `undefined` — the list has not loaded, or the request failed — is
 * answered `false`: NOT an operator. See {@link useOperatesAccount} for why that
 * direction, and not the other one.
 */
export function operatesAccount(
  nodes: readonly AccountNode[] | undefined,
  accountId: string | null | undefined,
): boolean {
  if (!nodes || !accountId) return false;
  return nodes.some((node) => node.accountId === accountId && operatesAccountNode(node));
}
