import sanitizeHtml from 'sanitize-html';
import { decode as decodeEntities } from 'he';
import { normalizeInlineText } from '@oxyhq/core';
import {
  createActorResolver,
  type FederatedActorStore,
  type FederatedActorUpsert,
  type WebFingerFetch,
  type WebFingerJrd,
} from '@oxyhq/federation/node';
import { logger } from '../../utils/logger';
import { withEngineId, type EngineFederatedActorRecord } from '../../db/federation/actorRecord';
import {
  findActorByPublicKeyId,
  findActorByUri,
  setActorOxyUserId,
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
    const { fields, uri: _uri, ...columns } = update;
    return withEngineId(await upsertActor(uri, columns, fields));
  },
  findActorByPublicKeyId: async (keyId) => withEngineId(await findActorByPublicKeyId(keyId)),
  setActorOxyUserId: async (actorId, oxyUserId) => {
    await setActorOxyUserId(String(actorId), oxyUserId);
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
export const actorService = createActorResolver<EngineFederatedActorRecord>({
  federationEnabled: FEDERATION_ENABLED,
  signedFetch,
  fetchWebFinger,
  isBlockedDomain,
  normalizeFederatedAcct,
  domainFromAcct,
  firstStringUrl,
  store,
  identity: {
    resolveExternalUser: (actor, opts) => resolveOxyExternalUser(actor, opts),
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
