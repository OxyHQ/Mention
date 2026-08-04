import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services/ui/client';
import type { AccountKind, AccountNode } from '@oxyhq/core';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { operatesAccount } from '@/lib/operatedAccounts';

/**
 * Whether the viewer OPERATES the profile being looked at — the question every
 * viewer-hostile affordance on a profile actually wants answered.
 *
 * The question it replaces is "is this profile me?", which is the whole truth
 * only for a personal login. A channel, organization, project or bot is never the
 * viewer's own id, and yet the viewer may publish as it, so an id comparison says
 * "no" for all four and offers Block / Report / Mute against an account you speak
 * with. Both profile screens ask this, because both serve managed accounts: only
 * `channel` routes to `/c/<handle>`, so an organization, project or bot renders on
 * the PERSON screen at `/@<handle>` and has always had the same defect.
 *
 * ## What it costs, and when
 *
 * The account graph is a real request, so it is only made when the answer can be
 * anything other than no. A `personal` account cannot be operated by anybody but
 * its own login — the backend refuses to publish as one on exactly that grounds —
 * so an ordinary profile skips the query entirely and this is free, which is the
 * overwhelming majority of profiles anybody opens. An unresolved profile (no kind
 * yet) skips it too rather than firing a request per cold load.
 *
 * It shares `viewerQueryKeys.operatedAccounts` with the composer's publish-as
 * picker and the channel-settings screen, so a viewer who has already opened
 * either pays nothing here.
 *
 * ## It fails toward SHOWING the action, deliberately
 *
 * While the list is loading, and if it fails, this answers `false` — not an
 * operator. The two mistakes are not comparable:
 *
 *  - Hiding Block and Report on a STRANGER's profile withholds the tools somebody
 *    reaches for when an account is harassing them, at the moment they reach for
 *    them, with nothing on screen to explain why they are missing.
 *  - Showing them on an account you operate offers something pointless, which the
 *    server refuses (`services/operatedAccountAccess.ts`) and which is undoable
 *    where it is not refused.
 *
 * So the affordance is hidden only on a POSITIVE confirmation, and the backend
 * fails in the same direction for the same reason — the button and the route
 * agree on what an unknown answer means, rather than one of them guessing.
 */
export function useOperatesAccount(params: {
  accountId: string | null | undefined;
  accountKind: AccountKind | undefined;
}): boolean {
  const { user: currentUser, oxyServices } = useAuth();

  // `personal` is not merely unlikely to be operated by somebody else — it cannot
  // be, and the backend gate says so in the same words. Anything else, including
  // a kind Oxy adds later, is worth asking about rather than assumed safe.
  const couldBeOperated = Boolean(params.accountKind) && params.accountKind !== 'personal';

  const { data } = useQuery<AccountNode[]>({
    queryKey: viewerQueryKeys.operatedAccounts(currentUser?.id),
    queryFn: () => oxyServices.listAccounts(),
    enabled: Boolean(currentUser?.id) && Boolean(params.accountId) && couldBeOperated,
  });

  return couldBeOperated && operatesAccount(data, params.accountId);
}
