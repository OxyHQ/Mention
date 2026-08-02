import sanitizeHtml from 'sanitize-html';
import { decode as decodeEntities } from 'he';
import { normalizeInlineText } from '@oxyhq/core';
import { deriveBridgedNetworkIdentity, type NormalizedExternalActor } from '@oxyhq/federation';
import {
  createActorResolver,
  type FederatedActorStore,
  type FederatedActorUpsert,
  type WebFingerFetch,
  type WebFingerJrd,
} from '@oxyhq/federation/node';
import { logger } from '../../utils/logger';
import FederatedActor, { type IFederatedActor } from '../../models/FederatedActor';
import { FEDERATION_ENABLED, isBlockedDomain } from './constants';
import { htmlToPlainText } from '../../utils/federation/htmlToPlainText';
import { fetchUpstreamSingleHop } from '../../utils/safeUpstreamFetch';
import {
  signedFetch,
  firstStringUrl,
  normalizeFederatedAcct,
  domainFromAcct,
} from './helpers';
import { readBoundedResponseBody } from '../shared/httpBody';
import { reportFederatedActorGone, resolveOxyExternalUser } from '../identity';

/**
 * Resolution, caching and refresh of remote ActivityPub actors.
 *
 * The PROTOCOL — webfinger resolution, the signed actor fetch + WebFinger
 * fallback, the 410-Gone tombstone, the self-consistency/same-origin guards, the
 * staleness/refresh policy — lives in `@oxyhq/federation`'s `createActorResolver`
 * so every Oxy app backend resolves remote actors identically. This module is the
 * Mention wiring: it supplies the FederatedActor CACHE store (bring-your-own-store,
 * no data move), the actor↔Oxy-user identity bridge, the signed AP fetch + the
 * SSRF-safe WebFinger fetch, and Mention's canonical text normalization.
 */

const WEBFINGER_TIMEOUT_MS = 10000;
const WEBFINGER_MAX_BYTES = 256 * 1024;

/**
 * Mention's actor CACHE store: the AP-specific `FederatedActor` rows stay in
 * Mention's Mongo, reached through this adapter. The exact Mongoose calls are
 * unchanged from the previous `ActorService`.
 */
const store: FederatedActorStore<IFederatedActor> = {
  findActorByUri: (uri) => FederatedActor.findOne({ uri }).lean<IFederatedActor>(),
  upsertActor: (uri, update: FederatedActorUpsert) =>
    FederatedActor.findOneAndUpdate(
      { uri },
      // `networkAcct` is absent for an ordinary actor, and an absent key in a
      // `$set` simply leaves the column alone — which would strand a stale value
      // on a row that STOPPED being bridged (a bridge removed from the policy, or
      // an actor that no longer satisfies its rule). Unset it explicitly so the
      // row can never keep claiming an identity it no longer derives.
      update.networkAcct === undefined
        ? { $set: update, $unset: { networkAcct: 1 } }
        : { $set: update },
      { upsert: true, returnDocument: 'after', lean: true },
    ) as Promise<IFederatedActor | null>,
  findActorByPublicKeyId: (keyId) =>
    FederatedActor.findOne({ publicKeyId: keyId }).lean<IFederatedActor>(),
  setActorOxyUserId: async (actorId, oxyUserId) => {
    await FederatedActor.updateOne({ _id: actorId }, { $set: { oxyUserId } });
  },
  tombstoneActor: (uri) =>
    FederatedActor.findOneAndUpdate(
      { uri },
      { $set: { suspended: true } },
      { returnDocument: 'after', projection: { oxyUserId: 1 } },
    ).lean<Pick<IFederatedActor, 'oxyUserId'>>(),
};

/**
 * SSRF-safe bounded WebFinger fetch. Validates + IP-pins the URL, enforces the
 * 256 KiB cap, and returns the parsed JRD (or null on a non-2xx). A network /
 * parse / size-limit failure throws and is treated by the resolver as a failed
 * resolution.
 */
const fetchWebFinger: WebFingerFetch = async (url) => {
  const { response, status } = await fetchUpstreamSingleHop(url, {
    headers: { Accept: 'application/jrd+json, application/json' },
    signal: AbortSignal.timeout(WEBFINGER_TIMEOUT_MS),
    headersTimeoutMs: WEBFINGER_TIMEOUT_MS,
  });
  if (status < 200 || status >= 300) {
    response.destroy();
    return null;
  }
  const body = await readBoundedResponseBody(response, WEBFINGER_MAX_BYTES);
  return JSON.parse(Buffer.from(body).toString('utf8')) as WebFingerJrd;
};

/**
 * Resolve a normalized actor to its Oxy user, MERGING two bridges' copies of the
 * same upstream person into one identity.
 *
 * An upstream handle is globally unique on its own network — there is exactly one
 * `@wired` on X — so two actor rows that re-label onto `wired@x.com` are not two
 * people who happen to collide, they are one person mirrored twice. Measured on
 * production: of 458 distinct X handles held across the two X bridges, 17 are
 * mirrored by both, and 79 of 815 Bridgy Fed Bluesky actors are accounts the
 * atproto connector already holds directly.
 *
 * Minting a second Oxy identity for the second copy is not merely untidy, it does
 * not work: `PUT /users/resolve` keys on the actor URI but the username carries a
 * unique index, so the second copy would be refused. So the second row ADOPTS the
 * first row's Oxy user instead of minting its own.
 *
 * This is reversible by construction. Nothing is rewritten and nothing is
 * deleted — the absorbed row keeps its own URI, acct, domain and content, and the
 * only thing it shares is which Oxy identity it points at. Removing a bridge from
 * the policy makes its rows re-derive their own identity again on the next
 * refresh.
 *
 * De-duplication is confined to actors that were actually RE-LABELLED (`networkAcct`
 * is set). An ordinary federated actor is untouched: its identity is its acct,
 * which is already unique per host, so there is nothing to merge and this function
 * is a straight pass-through for the overwhelming majority of actors.
 *
 * Two ingests of the same handle racing each other can both find no owner and both
 * try to mint; oxy-api's unique index refuses the loser, which the identity bridge
 * reports as an unresolved actor (no orphan is written) and the next refresh
 * settles. That is a rare, self-correcting outcome, and the alternative — a lock
 * around a cross-service call — would be a worse trade.
 *
 * Exported so the merge rule can be exercised directly: it decides which person a
 * piece of writing is attributed to, and that decision deserves to be readable in
 * a test rather than reachable only through a full actor fetch.
 */
export async function resolveFederatedActorIdentity(
  actor: NormalizedExternalActor,
  opts?: { forceAvatarRefresh?: boolean },
): Promise<string | null> {
  // Only a re-labelled actor can share an identity with another row. `handle` is
  // the protocol acct and `federatedUsername` the stored identity; they differ
  // exactly when the bridge policy relabelled this actor.
  if (actor.federatedUsername === actor.handle) {
    return resolveOxyExternalUser(actor, opts);
  }

  try {
    const owner = await FederatedActor.findOne(
      {
        networkAcct: actor.federatedUsername,
        uri: { $ne: actor.externalId },
        oxyUserId: { $exists: true, $ne: null },
      },
      { uri: 1, oxyUserId: 1 },
    ).lean<Pick<IFederatedActor, 'uri' | 'oxyUserId'>>();

    if (owner?.oxyUserId) {
      // Identifiers ride in the structured payload, never interpolated into the
      // message — the backend logging policy holds every call site to that.
      logger.info(
        '[FedSync] bridged identity is already held by another actor; adopting its Oxy user',
        { actor: actor.externalId, networkAcct: actor.federatedUsername, owner: owner.uri },
      );
      return owner.oxyUserId;
    }
  } catch (err) {
    // A failed lookup must not lose the actor: fall through and resolve normally.
    // The worst case is the duplicate this merge exists to avoid, which oxy-api
    // then refuses — a visible, recoverable outcome, unlike dropping the actor.
    logger.warn('[FedSync] bridged-identity owner lookup failed', { actor: actor.externalId, err });
  }

  return resolveOxyExternalUser(actor, opts);
}

/**
 * The remote-actor resolver instance. Every consumer keeps using
 * `actorService.resolveWebFinger / fetchRemoteActor / getOrFetchActor /
 * tombstoneGoneActor / refreshActorInBackground / fetchPublicKey /
 * resolveActorOxyUserId` unchanged.
 */
export const actorService = createActorResolver<IFederatedActor>({
  federationEnabled: FEDERATION_ENABLED,
  signedFetch,
  fetchWebFinger,
  isBlockedDomain,
  normalizeFederatedAcct,
  domainFromAcct,
  firstStringUrl,
  // A bridge republishes another network's accounts under its own hostname, so an
  // actor from one is stored under the network it actually came from —
  // `@wired@x.com`, not `@wired@bird.makeup`. The policy lives in
  // `@oxyhq/federation` because oxy-api's `PUT /users/resolve` has to agree with
  // it: that endpoint binds an actor URI's host to the domain being claimed, and
  // a bridged identity is the one legitimate exception. Only the IDENTITY moves —
  // `acct`, `uri` and the stored `domain` keep addressing the bridge, so the
  // domain policy and every moderation consumer are unaffected.
  //
  // `isBlockedDomain` is evaluated by the resolver well before this runs, and a
  // blocked host never reaches it.
  deriveNetworkIdentity: deriveBridgedNetworkIdentity,
  store,
  identity: {
    resolveExternalUser: (actor, opts) => resolveFederatedActorIdentity(actor, opts),
    reportActorGone: (oxyUserId) => reportFederatedActorGone(oxyUserId),
  },
  text: {
    inlineField: (value) => (typeof value === 'string' ? normalizeInlineText(value) : ''),
    inlineDisplayName: (raw) => normalizeInlineText(decodeEntities(raw)),
    // Sanitize BEFORE normalizing: the canonical normalizer collapses whitespace,
    // it never strips markup — so the sanitizer must run first, on the raw value.
    sanitizeFieldValue: (html) =>
      normalizeInlineText(
        sanitizeHtml(html, {
          allowedTags: ['a', 'span'],
          allowedAttributes: { a: ['href', 'rel'] },
        }),
      ),
    htmlToPlainText: (html) => htmlToPlainText(html),
  },
  logger: {
    info: (message) => logger.info(message),
    warn: (message, detail) => logger.warn(message, detail),
  },
});

export default actorService;
