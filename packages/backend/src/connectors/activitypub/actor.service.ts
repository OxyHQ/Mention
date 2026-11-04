import { resolveAvatarUrl } from '../../utils/mediaResolver';
import sanitizeHtml from 'sanitize-html';
import { decode as decodeEntities } from 'he';
import { normalizeInlineText } from '@oxy.so/core';
import { readResponseJson, safeFetch } from '@oxy.so/core/server';
import {
  createActorResolver,
  type ActorDocumentFetch,
  type ActorResolverConfig,
  type FederatedActorStore,
  type FederatedActorUpsert,
  type WebFingerFetch,
  type WebFingerJrd,
} from '@oxy.so/federation/node';
import { isSameFederationHost } from '@oxy.so/federation';
import { logger } from '../../utils/logger';
import { withEngineId, type EngineFederatedActorRecord } from '../../db/federation/actorRecord';
import { isUniqueViolation } from '@oxy.so/db';
import {
  findActorByPublicKeyId,
  findActorByUri,
  findOtherActorHoldingHandle,
  releaseGoneActorHandle,
  setActorMovedTo,
  tombstoneActor,
  upsertActor,
} from '../../db/federation/actorRepository';
import { recordRemoteMove } from './move.service';
import { FEDERATION_ENABLED, isBlockedDomain } from './constants';
import { htmlToPlainText } from '../../utils/federation/htmlToPlainText';
import { signedFetch, normalizeFederatedAcct, domainFromAcct } from './helpers';
import { reportFederatedActorGone } from '../identity';
import { observeOxySource, type ObservedOxySource } from '../oxyIdentity';
import { reconcileActorIdentityProjection } from '../../services/ActorIdentityProjectionService';
import { syncFederatedBannerInBackground } from '../../db/federation/bannerMirrorRepository';
import { trustedRemoteCreatedAt } from '../../services/federation/remoteProfileStats';

/**
 * Resolution, caching and refresh of remote ActivityPub actors.
 *
 * The PROTOCOL — webfinger resolution, the WebFinger fallback, the 410-Gone
 * tombstone, the self-consistency/same-origin guards, the staleness/refresh
 * policy — lives in `@oxy.so/federation`'s `createActorResolver` so every Oxy app
 * backend resolves remote actors identically. This module is the Mention wiring:
 * the FederatedActor CACHE store (bring-your-own-store, no data move), the actor
 * document source (Oxy's verified read, {@link fetchActorDocument}), the signed AP
 * fetch for collections + the SSRF-safe WebFinger fetch, and Mention's canonical
 * text normalization.
 */

const WEBFINGER_TIMEOUT_MS = 10000;
const WEBFINGER_MAX_BYTES = 256 * 1024;

/** The two unique constraints a remote rename can collide with. */
const HANDLE_CONSTRAINTS = [
  'federated_actors_acct_key',
  'federated_actors_domain_username_key',
] as const;

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
async function freeStaleHandle(
  uri: string,
  handle: { acct: string; domain: string; username: string },
): Promise<boolean> {
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
const store: FederatedActorStore<EngineFederatedActorRecord, ObservedOxySource> = {
  findActorByUri: async (uri) => withEngineId(await findActorByUri(uri)),
  upsertActor: async (uri, update: FederatedActorUpsert, resolved) => {
    // `fields` is the one part of the write that is a second TABLE rather than a
    // column, so it is split out here and the repository replaces the whole list
    // inside the same transaction as the row.
    //
    // Oxy's per-source alias is a projection for content provenance. Transport
    // acct/domain/keys remain the remote actor's delivery coordinates.
    //
    // `discoverable` and `indexable` arrive in `columns`. The resolver leaves
    // `indexable` out when the actor does not state it, and the row then stores
    // NULL ("said nothing"), which `federatedSearchOptOutSql` reads as not
    // indexable — Mastodon's rule for a remote account.
    //
    // `resolved` is the Oxy answer the document was read from
    // ({@link fetchActorDocument}): the identity is already verified, so the
    // store never asks Oxy (or the source) again.
    if (resolved?.externalIdentity.actorUri !== uri)
      throw new Error('Actor document was not read through Oxy');
    const { fields, uri: _uri, ...columns } = update;
    const row = await upsertActorFreeingStaleHandle(
      uri,
      {
        ...columns,
        // The engine parses `published` with a bare `new Date(...)`; an unparseable
        // one must not fail the refresh it rides on. See `trustedRemoteCreatedAt`.
        remoteCreatedAt: trustedRemoteCreatedAt(columns.remoteCreatedAt),
        networkAcct: resolved.externalIdentity.canonicalAcct,
        summary: resolved.user.bio ?? '',
        avatarUrl: resolveAvatarUrl(resolved.user.avatar),
      },
      fields,
    );
    if (!row) return null;
    const projection = await reconcileActorIdentityProjection({
      actorUri: uri,
      oxyUserId: resolved.user.id,
      networkAcct: resolved.externalIdentity.canonicalAcct,
      check: 'refresh',
    });
    if (projection.refusal) throw new Error('Source identity projection failed');
    // Every ActivityPub actor write passes here, from a full fetch of the actor:
    // its `image` (or the lack of one) is the banner the profile shows.
    syncFederatedBannerInBackground({
      oxyUserId: resolved.user.id,
      actorUri: uri,
      bannerUrl: columns.headerUrl,
    });
    // A move the actor announces is believed only once its target confirms it,
    // the same bilateral check an inbound Move gets; one it no longer announces
    // was cancelled. Never awaited for the check: it fetches the target.
    if (update.movedTo && update.movedTo !== row.movedTo) {
      const targetActorUri = update.movedTo;
      void recordRemoteMove({ oldActorUri: uri, targetActorUri }).catch((error: unknown) => {
        logger.info('[FedSync] could not verify an announced move', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
      });
    } else if (!update.movedTo && row.movedTo) {
      await setActorMovedTo(uri, null);
    }
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
 * Every actor document comes from Oxy's verified read of it
 * ({@link observeOxySource}), never from a fetch of Mention's own: Oxy has to
 * fetch the actor to verify it, so a second fetch here would read the same
 * document twice per sync. The answer rides to {@link store}'s upsert as its
 * `source`. A source that refused Oxy reports its own status (410 tombstones).
 */
const fetchActorDocument: ActorDocumentFetch<ObservedOxySource> = async (actorUri, acctHint) => {
  // A hint on another host is an unverified claim: Oxy is not asked to chase it
  // (the resolver ignores it too).
  const hintDomain = acctHint ? domainFromAcct(acctHint) : undefined;
  const { status, resolved } = await observeOxySource({
    actorUri,
    transportAcct:
      hintDomain && isSameFederationHost(hintDomain, new URL(actorUri).hostname)
        ? acctHint
        : undefined,
    protocol: 'activitypub',
  });
  if (!resolved) return { status, detail: 'Oxy could not verify the actor' };
  return { status, document: resolved.sourceDocument, source: resolved };
};

/**
 * SSRF-safe bounded WebFinger fetch. Validates + IP-pins the URL, reads the body
 * within the 256 KiB cap and {@link WEBFINGER_TIMEOUT_MS}, and returns the parsed
 * JRD (or null on a non-2xx). A network, parse, size-limit or body-deadline
 * failure throws, naming which, and the resolver treats it as a failed
 * resolution (nothing is cached, so the next lookup tries again).
 */
const fetchWebFinger: WebFingerFetch = async (url) => {
  const { response, status } = await safeFetch(url, {
    redirect: 'manual',
    headers: { Accept: 'application/jrd+json, application/json' },
    signal: AbortSignal.timeout(WEBFINGER_TIMEOUT_MS),
    headersTimeoutMs: WEBFINGER_TIMEOUT_MS,
  });
  if (status < 200 || status >= 300) {
    response.destroy();
    return null;
  }
  const result = await readResponseJson<WebFingerJrd>(response, {
    maxBytes: WEBFINGER_MAX_BYTES,
    timeoutMs: WEBFINGER_TIMEOUT_MS,
  });
  switch (result.kind) {
    case 'ok':
      return result.value;
    case 'too_large':
      throw new Error(`WebFinger response exceeded ${WEBFINGER_MAX_BYTES} bytes`);
    case 'timeout':
      throw new Error(`WebFinger response body did not end within ${WEBFINGER_TIMEOUT_MS} ms`);
    case 'invalid_json':
      throw new Error('WebFinger response is not JSON');
    case 'error':
      throw result.error;
  }
};

/**
 * The resolver's configuration.
 *
 * Deliberately supplies neither `deriveNetworkIdentity` nor `qualifyHandles`:
 * the canonical network identity, bridge relabelling and the bio (boilerplate
 * stripped, handles qualified) all come from Oxy's
 * `/federation/identities/resolve` in `store.upsertActor` (OxyHQ/oxy#1253).
 */
export const activityPubActorResolverConfig: ActorResolverConfig<
  EngineFederatedActorRecord,
  ObservedOxySource
> = {
  federationEnabled: FEDERATION_ENABLED,
  signedFetch,
  fetchActorDocument,
  fetchWebFinger,
  isBlockedDomain,
  normalizeFederatedAcct,
  domainFromAcct,
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

export const actorService = createActorResolver(activityPubActorResolverConfig);

export default actorService;
