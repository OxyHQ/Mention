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
import {
  findActorByPublicKeyId,
  findActorByUri,
  tombstoneActor,
  upsertActor,
} from '../../db/federation/actorRepository';
import { FEDERATION_ENABLED, isBlockedDomain } from './constants';
import { qualifyBareHandles } from '@mention/shared-types/textEntities';
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
    const row = await upsertActor(uri, {
      ...columns,
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
 * The resolver's configuration, named so it can be INSPECTED.
 *
 * Bound to a const rather than inlined into the call because several members are
 * optional hooks: an engine given no `qualifyHandles` falls back to the previous
 * behaviour silently and by design, so a wire that is never connected produces
 * no error anywhere. Both sides of that hook were green while Mention's bios
 * stayed unqualified. Naming the object is what lets a test look.
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
    // A handle an actor wrote in its OWN bio means the account on the network it
    // was written on: `@openai` on an X-relabelled actor is `@openai@x.com`.
    // Copied across unqualified it reads as a LOCAL name, pointing readers at
    // whoever holds it here. Qualified on ingest so it is STORED unambiguous —
    // every reader gets the same text from the same field, with no renderer left
    // to re-derive it from an origin network it would have to be told.
    //
    // `qualifyBareHandles` scans with the SAME entity scanner the composer and
    // the renderer use, so a URL's `@handle`, an email and an already-qualified
    // handle are excluded by that one definition rather than by a rule invented
    // here for bios.
    qualifyHandles: (text, instanceDomain) => qualifyBareHandles(text, instanceDomain),
  },
  logger: {
    info: (message) => logger.info(message),
    warn: (message, detail) => logger.warn(message, detail),
  },
};

export const actorService = createActorResolver<EngineFederatedActorRecord>(activityPubActorResolverConfig);

export default actorService;
