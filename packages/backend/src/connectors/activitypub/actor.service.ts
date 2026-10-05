import { resolveAvatarUrl } from '../../utils/mediaResolver';
import sanitizeHtml from 'sanitize-html';
import { decode as decodeEntities } from 'he';
import { normalizeInlineText } from '@oxy.so/core';
import {
  createActorResolver,
  type ActorResolverConfig,
  type FederatedActorStore,
  type FederatedActorUpsert,
  type WebFingerFetch,
  type WebFingerJrd,
} from '@oxy.so/federation/node';
import { logger } from '../../utils/logger';
import { withEngineId, type EngineFederatedActorRecord } from '../../db/federation/actorRecord';
import { isUniqueViolation } from '@oxy.so/db';
import {
  findActorByPublicKeyId,
  findActorByUri,
  findOtherActorHoldingHandle,
  releaseGoneActorHandle,
  tombstoneActor,
  upsertActor,
} from '../../db/federation/actorRepository';
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
import { reportFederatedActorGone } from '../identity';
import { resolveOxyIdentity } from '../oxyIdentity';
import { reconcileActorIdentityProjection } from '../../services/ActorIdentityProjectionService';
import { trustedRemoteCreatedAt } from '../../services/federation/remoteProfileStats';

/**
 * Resolution, caching and refresh of remote ActivityPub actors.
 *
 * The PROTOCOL — webfinger resolution, the signed actor fetch + WebFinger
 * fallback, the 410-Gone tombstone, the self-consistency/same-origin guards, the
 * staleness/refresh policy — lives in `@oxy.so/federation`'s `createActorResolver`
 * so every Oxy app backend resolves remote actors identically. This module is the
 * Mention wiring: it supplies the FederatedActor CACHE store (bring-your-own-store,
 * no data move), the actor↔Oxy-user identity bridge, the signed AP fetch + the
 * SSRF-safe WebFinger fetch, and Mention's canonical text normalization.
 */

const WEBFINGER_TIMEOUT_MS = 10000;
const WEBFINGER_MAX_BYTES = 256 * 1024;

/** The two unique constraints a remote rename can collide with. */
const HANDLE_CONSTRAINTS = ['federated_actors_acct_key', 'federated_actors_domain_username_key'] as const;

/** Stale holders being re-checked right now, so a handle SWAP cannot recurse forever. */
const handlesBeingFreed = new Set<string>();

/**
 * Try to free a handle a DIFFERENT row still holds, so the actor that owns it
 * now can be stored.
 *
 * Remote accounts rename (a new `preferredUsername` on the same URI), and a
 * handle a deleted or renamed account gave up can be taken by a new one. The
 * cache still has the old holder under that handle, so the new owner's upsert
 * hit the unique constraint and the actor never resolved. The holder is
 * re-fetched instead of trusted:
 *
 * - it now has another handle: the refresh wrote it, and the handle is free;
 * - it is gone (410, tombstoned): its handle is released
 *   ({@link releaseGoneActorHandle});
 * - it still claims the handle: refused, exactly as before. Silently taking a
 *   handle a live actor holds would let one server hijack another's identity.
 */
async function freeStaleHandle(uri: string, handle: { acct: string; domain: string; username: string }): Promise<boolean> {
  const holder = await findOtherActorHoldingHandle(handle, uri);
  if (!holder || handlesBeingFreed.has(holder.uri)) return false;
  handlesBeingFreed.add(holder.uri);
  try {
    await actorService.fetchRemoteActor(holder.uri);
  } finally {
    handlesBeingFreed.delete(holder.uri);
  }
  const stillHeld = await findOtherActorHoldingHandle(handle, uri);
  if (!stillHeld) return true;
  if (stillHeld.id === holder.id && stillHeld.suspended) return releaseGoneActorHandle(holder.id);
  return false;
}

/** {@link upsertActor}, retried once after {@link freeStaleHandle} clears a stale holder. */
async function upsertActorFreeingStaleHandle(
  ...args: Parameters<typeof upsertActor>
): ReturnType<typeof upsertActor> {
  const [uri, columns] = args;
  try {
    return await upsertActor(...args);
  } catch (error) {
    if (!HANDLE_CONSTRAINTS.some((constraint) => isUniqueViolation(error, constraint))) throw error;
    const freed = await freeStaleHandle(uri, columns);
    logger.info('[FedSync] handle held by another actor', { uri, acct: columns.acct, freed });
    if (!freed) throw error;
    return upsertActor(...args);
  }
}

/**
 * Mention's actor CACHE store: the AP-specific `federated_actors` rows stay in
 * Mention's Postgres, reached through this adapter. Every query lives in
 * `db/federation/actorRepository.ts`; this only adapts the shapes the engine's
 * interface names.
 */
const store: FederatedActorStore<EngineFederatedActorRecord> = {
  findActorByUri: async (uri) => withEngineId(await findActorByUri(uri)),
  upsertActor: async (uri, update: FederatedActorUpsert) => {
    // `fields` is the one part of the write that is a second TABLE rather than a
    // column, so it is split out here and the repository replaces the whole list
    // inside the same transaction as the row.
    //
    // Oxy's per-source alias is a projection for content provenance. Transport
    // acct/domain/keys remain the remote actor's delivery coordinates.
    const { fields, uri: _uri, ...columns } = update;
    const resolved = await resolveOxyIdentity({ actorUri: uri, transportAcct: update.acct, protocol: 'activitypub' });
    if (resolved.externalIdentity.actorUri !== uri) throw new Error('Oxy resolved a different source actor');
    const row = await upsertActorFreeingStaleHandle(uri, {
      ...columns,
      // The engine parses `published` with a bare `new Date(...)`; an unparseable
      // one must not fail the refresh it rides on. See `trustedRemoteCreatedAt`.
      remoteCreatedAt: trustedRemoteCreatedAt(columns.remoteCreatedAt),
      networkAcct: resolved.externalIdentity.canonicalAcct,
      summary: resolved.user.bio ?? '',
      avatarUrl: resolveAvatarUrl(resolved.user.avatar),
    }, fields);
    if (!row) return null;
    const projection = await reconcileActorIdentityProjection({ actorUri: uri, oxyUserId: resolved.user.id, networkAcct: resolved.externalIdentity.canonicalAcct });
    if (projection.refusal) throw new Error('Source identity projection failed');
    return withEngineId({ ...row, oxyUserId: resolved.user.id });
  },
  findActorByPublicKeyId: async (keyId) => withEngineId(await findActorByPublicKeyId(keyId)),
  setActorOxyUserId: async () => {
    // The source-aware upsert has already resolved and reconciled identity.
    throw new Error('Identity must be assigned through source projection');
  },
  tombstoneActor: (uri) => tombstoneActor(uri),
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
 * The remote-actor resolver instance. Every consumer keeps using
 * `actorService.resolveWebFinger / fetchRemoteActor / getOrFetchActor /
 * tombstoneGoneActor / refreshActorInBackground / fetchPublicKey /
 * resolveActorOxyUserId` unchanged.
 */
/**
 * The resolver's configuration.
 *
 * Deliberately supplies neither `deriveNetworkIdentity` nor `qualifyHandles`:
 * the canonical network identity, bridge relabelling and the bio (boilerplate
 * stripped, handles qualified) all come from Oxy's
 * `/federation/identities/resolve` in `store.upsertActor` (OxyHQ/oxy#1253).
 */
export const activityPubActorResolverConfig: ActorResolverConfig<EngineFederatedActorRecord> = {
  federationEnabled: FEDERATION_ENABLED,
  signedFetch,
  fetchWebFinger,
  isBlockedDomain,
  normalizeFederatedAcct,
  domainFromAcct,
  firstStringUrl,
  store,
  identity: {
    resolveExternalUser: async (actor) => actor.oxyUserId ?? null,
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
};

export const actorService = createActorResolver<EngineFederatedActorRecord>(activityPubActorResolverConfig);

export default actorService;
