import { createDeliveryService, type DeliveryService } from '@oxyhq/federation/node';
import { assertSafePublicUrl } from '@oxyhq/core/server';
import { logger } from '../../utils/logger';
import FederatedActor, { type IFederatedActor } from '../../models/FederatedActor';
import FederatedFollow from '../../models/FederatedFollow';
import FederationDeliveryQueue from '../../models/FederationDeliveryQueue';
import UserSettings from '../../models/UserSettings';
import { getPublicKey, signViaOxy } from './crypto';
import {
  AP_CONTENT_TYPE,
  FEDERATION_ENABLED,
  USER_AGENT,
  federationUrls,
  resolveOxyUser,
} from './constants';
import { actorService } from './actor.service';
import { buildLocalActorObject } from './actorObject';
import { fetchUpstreamSingleHop } from '../../utils/safeUpstreamFetch';
import { enqueueDelivery } from '../../queue/producers';
import { isFediverseSharingEnabled } from '../../services/fediverseSharing';

/**
 * Mention's outbound DELIVERY service.
 *
 * The delivery transport (sign → SSRF-safe POST → BullMQ/Mongo durable queue), the
 * shared-inbox dedup fan-out, and the follow protocol (Follow / Undo(Follow) /
 * Accept(Follow)) + the `Update(Person)` rebroadcast now live in
 * `@oxyhq/federation`'s `createDeliveryService` so every Oxy app federates
 * identically. This module is the Mention wiring: it binds the engine to Mention's
 * private-key custody (oxy-api, via `crypto.ts`), the SSRF-safe single-hop POST
 * (`fetchUpstreamSingleHop`), the BullMQ producer + the Mongo `FederationDeliveryQueue`
 * fallback, the `FederatedActor` / `FederatedFollow` stores, the actor resolver,
 * the fediverse-sharing consent gate, and the canonical actor builder.
 *
 * The CONTENT federate methods (`federateNewPost` / `federateBoost` / … in
 * `follow.service.ts`) keep building their Notes/boosts/likes and call
 * `deliveryService.deliverToFollowers` / `queueDelivery` / `resolveActorInbox`.
 */
export const deliveryService: DeliveryService = createDeliveryService<IFederatedActor>({
  federationEnabled: FEDERATION_ENABLED,
  userAgent: USER_AGENT,
  apContentType: AP_CONTENT_TYPE,
  // `sign` is wrapped rather than passed by reference so `signViaOxy` is read at
  // CALL time (matching the former `deliverActivity`), not at module init — the
  // private-key signer is a runtime credential, never touched just to load.
  keys: { getPublicKey, sign: (keyId, signingString) => signViaOxy(keyId, signingString) },
  urls: federationUrls,
  // The SSRF-safe single-hop POST — validates + IP-pins the inbox URL and returns
  // the raw `IncomingMessage` (which the engine reads a bounded preview of on
  // failure and destroys on success). Does NOT follow redirects (an inbox POST
  // never legitimately redirects).
  deliverSingleHop: (url, init) =>
    fetchUpstreamSingleHop(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
      headersTimeoutMs: init.headersTimeoutMs,
    }).then((result) => ({ response: result.response, status: result.status })),
  assertSafeInboxUrl: (url) => assertSafePublicUrl(url),
  transport: {
    // Wrapped so `enqueueDelivery` is read at CALL time, not module init (a
    // delivery producer is a runtime dependency, never touched just to load).
    enqueueDelivery: (job) => enqueueDelivery(job),
    fallbackQueue: {
      create: (job) => FederationDeliveryQueue.create(job),
      insertMany: (jobs) => FederationDeliveryQueue.insertMany(jobs, { ordered: false }),
    },
  },
  store: {
    findActorByUri: (uri) => FederatedActor.findOne({ uri }).lean<IFederatedActor>(),
    findActorInboxesByUris: (uris) =>
      FederatedActor.find({ uri: { $in: uris } })
        .lean<Array<Pick<IFederatedActor, 'sharedInboxUrl' | 'inboxUrl'>>>(),
  },
  follows: {
    listAcceptedInboundFollowerActorUris: async (localOxyUserId) => {
      const follows = await FederatedFollow.find({
        localUserId: localOxyUserId,
        direction: 'inbound',
        status: 'accepted',
      }).lean<Array<{ remoteActorUri: string }>>();
      return follows.map((f) => f.remoteActorUri);
    },
    upsertOutboundPending: async (localOxyUserId, remoteActorUri, activityId) => {
      await FederatedFollow.findOneAndUpdate(
        { localUserId: localOxyUserId, remoteActorUri, direction: 'outbound' },
        { $set: { status: 'pending', activityId } },
        { upsert: true, returnDocument: 'after' },
      );
    },
    findOutbound: (localOxyUserId, remoteActorUri) =>
      FederatedFollow.findOne({
        localUserId: localOxyUserId,
        remoteActorUri,
        direction: 'outbound',
      }).lean<{ _id: unknown; activityId?: string } | null>(),
    deleteById: async (id) => {
      await FederatedFollow.deleteOne({ _id: id });
    },
  },
  actorRefresh: {
    refreshActorInBackground: (actorUri, existing) =>
      actorService.refreshActorInBackground(actorUri, existing),
    fetchRemoteActor: (actorUri) => actorService.fetchRemoteActor(actorUri),
  },
  consent: { isSharingEnabled: (oxyUserId) => isFediverseSharingEnabled(oxyUserId) },
  identity: { resolveUserByUsername: (username) => resolveOxyUser(username) },
  profile: {
    getBanner: async (oxyUserId) => {
      const settings = await UserSettings.findOne({ oxyUserId }, { profileHeaderImage: 1 })
        .lean<{ profileHeaderImage?: string } | null>();
      return settings?.profileHeaderImage ?? null;
    },
  },
  buildLocalActorObject,
  logger: {
    debug: (message, detail) => (detail === undefined ? logger.debug(message) : logger.debug(message, detail)),
    info: (message) => logger.info(message),
    warn: (message) => logger.warn(message),
    error: (message, detail) => (detail === undefined ? logger.error(message) : logger.error(message, detail)),
  },
});

export default deliveryService;
