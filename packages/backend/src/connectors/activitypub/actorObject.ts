import { eq } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { userSettings } from '../../db/schema/userProfile';
import { createLocalActorBuilder, type ActorMediaResolver } from '@oxy.so/federation';
import { logger } from '../../utils/logger';
import { resolveAvatarUrl, resolveMediaRef } from '../../utils/mediaResolver';
import { FEDERATION_DOMAIN, federationUrls } from './constants';

/**
 * The single builder of a LOCAL user's ActivityPub `Person` actor document.
 *
 * The byte-identical actor assembly (field set, ordering, `icon`/`image`
 * absolute-URL invariant, `publicKey`) lives in `@oxy.so/federation` so every Oxy
 * app federates identically; this module binds it to Mention's domain, URL
 * builders, and canonical media chokepoint. It is shared by the GET actor route
 * (which serves it as a standalone JSON-LD document) and the outbound
 * `Update(Person)` broadcast, so a follower's Mastodon renders the same actor
 * whether it was fetched or pushed.
 */

/** Fields of the resolved Oxy user the actor document reads. */
export interface ActorUserView {
  _id?: string | null;
  id?: string | null;
  name?: { displayName?: string | null } | null;
  bio?: string | null;
  avatar?: string | null;
  createdAt?: string | null;
}

/**
 * Mention's actor media adapter for the engine's actor builder. The avatar
 * (`icon`) resolves through the canonical `resolveAvatarUrl` (Oxy file id →
 * absolute CDN URL, external URL → proxied). The banner (`image`) — stored in
 * Mention's own `UserSettings.profileHeaderImage` — resolves through
 * `resolveMediaRef`. The engine enforces the absolute-URL invariant on both.
 */
const actorMedia: ActorMediaResolver = {
  resolveAvatar: (ref) => resolveAvatarUrl(ref),
  resolveBanner: (ref) => resolveMediaRef(ref).url,
};

/**
 * Assemble a LOCAL user's AP `Person` actor object (WITHOUT the top-level
 * `@context` — the caller owns that). `displayName` is the caller-resolved Oxy
 * `name.displayName` (falling back to the handle); it is never recomposed from
 * name parts here. The banner lives in Mention's own `UserSettings`, passed in as
 * `profileHeaderImage`.
 */
export const buildLocalActorObject = createLocalActorBuilder({
  domain: FEDERATION_DOMAIN,
  urls: federationUrls,
  media: actorMedia,
  onWarn: (message) => logger.warn(message),
});

/**
 * The profile banner Mention owns, from `user_settings`.
 *
 * ONE reader for the two call sites that need it — the actor GET
 * (`engine.routes.ts`) and the `Update(Person)` broadcast
 * (`delivery.service.ts`). One reader means the two cannot drift onto different
 * stores: a read that returns no row is silently "no banner" (`?? null`), so a
 * stale reader would omit `image` from every actor JSON with no error.
 */
export async function loadProfileBanner(oxyUserId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ profileHeaderImage: userSettings.profileHeaderImage })
    .from(userSettings)
    .where(eq(userSettings.oxyUserId, oxyUserId))
    .limit(1);
  return row?.profileHeaderImage ?? null;
}
