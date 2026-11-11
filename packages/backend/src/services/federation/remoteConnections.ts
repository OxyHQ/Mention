/**
 * A profile's followers / following, as `GET /profile/connections/:userId/:kind`
 * serves them: Oxy's follow graph (the people who followed the account from an
 * Oxy app) followed by the mirrored remote edges whose other end is an account
 * known here (`connectors/remoteGraphMirror.ts`).
 *
 * Oxy refuses a remote→remote follow, so without the mirror a federated
 * profile's lists name only the people who followed it from here. The origin's
 * TOTALS keep coming from the actor row (`remoteProfileStats`); this lists who
 * of them can be shown, never more than the origin published:
 *
 * - An ActivityPub collection is listed only once a crawl found it visible. One
 *   the origin hides (or that was never read) adds nobody, even though other
 *   accounts' public collections name some of its edges — listing those would
 *   rebuild the list its owner hid.
 * - The viewer's blocks, mutes and restrictions are removed, as on the
 *   engagement lists (`postEngagementAudience`); a profile the viewer excluded
 *   lists nobody.
 * - A signed-out viewer sees nothing of a profile that hides itself from
 *   signed-out readers, and no listed account that does.
 *
 * Paging is two phases in one opaque cursor: Oxy's offset pages, then the
 * mirror's keyset over Oxy ids. The two sets do not overlap (Oxy holds no
 * remote→remote edge, the mirror lists only remote accounts).
 */

import type { OxyClient } from '../../utils/privacyHelpers';
import type { ProfileConnectionsPage } from '@mention/shared-types/profile';
import {
  findActorsByOxyUserIds,
  findFederatedVisibilityOptOuts,
} from '../../db/federation/actorRepository';
import {
  loadRemoteGraphStates,
  pageMirroredConnections,
} from '../../db/federation/remoteGraphRepository';
import { crawlRemoteGraphInBackground, graphNode } from '../../connectors/remoteGraphMirror';
import { UserPrivacyManager } from '../../mtn/UserPrivacyManager';
import { decodeOffsetCursor, encodeOffsetCursor } from '../../utils/offsetCursor';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { resolveUserSummaries } from '../PostHydrationService';

export type ConnectionKind = 'followers' | 'following';

const MIRROR_PHASE = 'mirror';

/**
 * The profile's mirror nodes on this side, or none when the mirror may list
 * nobody there (see the module docblock).
 */
async function mirrorSelfNodes(
  profileUserId: string,
  kind: ConnectionKind,
  signedIn: boolean,
): Promise<string[]> {
  const actors = (await findActorsByOxyUserIds([profileUserId])).filter(
    (actor) => actor.protocol === 'activitypub' || actor.protocol === 'atproto',
  );
  if (actors.length === 0) return [];
  for (const actor of actors) crawlRemoteGraphInBackground(actor);
  if (actors.some((actor) => actor.suspended)) return [];
  if (
    !signedIn &&
    (await findFederatedVisibilityOptOuts([profileUserId])).get(profileUserId)?.requiresSignIn
  ) {
    return [];
  }

  const states = await loadRemoteGraphStates(actors.map((actor) => actor.uri));
  const visible = actors.every((actor) => {
    // A Bluesky graph is public by protocol, also when the account is held here
    // through its Bridgy Fed actor (whose node is the DID).
    if (actor.protocol === 'atproto' || graphNode(actor.uri).startsWith('did:')) return true;
    const state = states.get(actor.uri);
    return (kind === 'followers' ? state?.followersState : state?.followingState) === 'visible';
  });
  return visible ? [...new Set(actors.map((actor) => graphNode(actor.uri)))] : [];
}

export async function loadProfileConnections(input: {
  profileUserId: string;
  kind: ConnectionKind;
  viewerId?: string;
  oxyClient?: OxyClient;
  cursor?: string;
  limit: number;
}): Promise<ProfileConnectionsPage> {
  const { profileUserId, kind, viewerId, limit } = input;
  const privacy = viewerId
    ? await UserPrivacyManager.loadPrivacyState(viewerId, {
        oxyClient: input.oxyClient,
        includeRestricted: true,
      })
    : undefined;
  const excluded = privacy?.excludedUserIds ?? new Set<string>();
  if (excluded.has(profileUserId)) return { users: [], hasMore: false };

  const cursor = decodeOffsetCursor(input.cursor) ?? { offset: 0 };
  const ids: string[] = [];
  let nextCursor: string | undefined;
  let mirrorAfter: string | undefined;
  let mirrorRoom = limit;

  if (cursor.phase !== MIRROR_PHASE) {
    const follows = getServiceOxyClient().follows;
    const params = { limit, offset: cursor.offset };
    const page =
      kind === 'followers'
        ? await follows.followers(profileUserId, params).then((p) => ({ ...p, users: p.followers }))
        : await follows
            .following(profileUserId, params)
            .then((p) => ({ ...p, users: p.following }));
    const { users } = page;
    for (const user of users) if (user.id && !excluded.has(user.id)) ids.push(user.id);
    if (page.hasMore) {
      return finish(ids, encodeOffsetCursor({ offset: cursor.offset + users.length }));
    }
    mirrorRoom = limit - users.length;
  } else {
    mirrorAfter = cursor.after;
  }

  const selfNodes = await mirrorSelfNodes(profileUserId, kind, Boolean(viewerId));
  if (selfNodes.length > 0) {
    const mirrored = await pageMirroredConnections({
      selfNodes,
      profileUserId,
      kind,
      excludedUserIds: excluded,
      signedIn: Boolean(viewerId),
      afterUserId: mirrorAfter,
      limit: mirrorRoom + 1,
    });
    const shown = mirrored.slice(0, mirrorRoom);
    ids.push(...shown);
    if (mirrored.length > mirrorRoom) {
      nextCursor = encodeOffsetCursor({
        offset: 0,
        phase: MIRROR_PHASE,
        after: shown.at(-1) ?? mirrorAfter,
      });
    }
  }
  return finish(ids, nextCursor);
}

/** Resolve the page's ids to the canonical Oxy user; one Oxy could not name is left out. */
async function finish(ids: string[], nextCursor?: string): Promise<ProfileConnectionsPage> {
  const unique = [...new Set(ids)];
  const summaries = await resolveUserSummaries(unique);
  const users = unique.flatMap((id) => {
    const user = summaries.get(id)?.user;
    return user?.username ? [user] : [];
  });
  return { users, hasMore: Boolean(nextCursor), nextCursor };
}
