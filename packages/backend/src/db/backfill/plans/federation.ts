/**
 * The federation identity and delivery tables: `actorkeypairs`,
 * `federatedactors` (+ its `fields[]`), `federatedfollows`,
 * `federatedmediacaches`, `federationdeliveryqueues`.
 *
 * ## `federatedactors` is where the flattening is worth reading
 *
 * Mongo nested a whole `outboxBackfill` subdocument — twelve leaves tracking a
 * resumable crawl of a remote actor's outbox. Every one becomes an
 * `outbox_backfill_*` column, and the cursor fields matter more than they look:
 * `AGENTS.md` records that a stale `lastOutboxSyncAt` makes an empty first sync
 * PERMANENT (the cooldown never lets it retry) until the value is cleared by
 * hand. Copying these verbatim therefore carries a live operational state, not
 * just history — a backfill that reset them would silently re-crawl every
 * remote actor, and one that dropped them would strand every partial crawl.
 *
 * ## `actorkeypairs` holds PRIVATE KEYS, and they are copied verbatim
 *
 * `privateKeyPem` is the signing key for every outbound HTTP signature. There is
 * no derivation and no regeneration path: a rotated key makes every previously
 * federated post unverifiable and every remote instance reject the actor until
 * it re-fetches. This is the one plan where "copy it exactly" is a security
 * property rather than a fidelity one.
 *
 * ## Three collections carry a NULLABLE unique key, and none needs a `where`
 *
 * `federated_actors.uri`, `.acct` and `federated_media_cache.remote_url` are all
 * `NOT NULL UNIQUE`, so the audit's presence filter is not doing partial-index
 * work there — it is simply never excluding anything. Stated because the MTN
 * plan's three PARTIAL indexes look identical at the call site and are not.
 */

import {
  actorKeyPairs,
  federatedActorFields,
  federatedActors,
  federatedFollows,
  federatedMediaCache,
  federationDeliveryQueue,
} from '../../schema/federation';
import type { CollectionPlan } from '../plan';
import { isUnresolvedAtprotoHandle } from '../../../connectors/atproto/unresolvedHandle';
import { KEEP_FRESHEST_FEDERATED_ACTOR } from '../resolutions';
import { buildRow } from '../rowBuilder';
import {
  bool,
  childRowId,
  date,
  int,
  ownId,
  reqDate,
  reqJsonObject,
  reqStr,
  str,
  strArray,
  subdocuments,
} from '../values';
import { optionalDate, timestamps } from './timestamps';

/** `actorkeypairs` → `actor_key_pairs`. One key pair per local user. */
const actorKeyPairsPlan: CollectionPlan = {
  collection: 'actorkeypairs',
  table: actorKeyPairs,
  uniquenessAudits: [
    {
      index: 'actor_key_pairs_oxy_user_id_key',
      key: [{ path: 'oxyUserId', normalize: 'exact' }],
    },
  ],
  transform: (doc, emit) => {
    emit(
      actorKeyPairs,
      buildRow(
        actorKeyPairs,
        {
          id: ownId(doc),
          oxyUserId: reqStr(doc, 'oxyUserId'),
          publicKeyPem: reqStr(doc, 'publicKeyPem'),
          // VERBATIM — see the module docblock. Not derivable, not regenerable.
          privateKeyPem: reqStr(doc, 'privateKeyPem'),
          keyId: reqStr(doc, 'keyId'),
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/**
 * `federatedactors` → `federated_actors` + `federated_actor_fields`.
 *
 * No `numericAudits`, and that is checked rather than forgotten: the remote
 * counts (`followersCount`, `followingCount`, `postsCount`) and the four
 * `outbox_backfill_*` counters carry defaults but NO CHECK, so there is no
 * constraint to predict. A remote instance reporting a negative follower count
 * is entirely possible and this schema accepts it — auditing for a bound the
 * column does not enforce would block the copy on data Postgres would take.
 */
const federatedActorsPlan: CollectionPlan = {
  collection: 'federatedactors',
  table: federatedActors,
  childTables: [federatedActorFields],
  enumAudits: [
    { path: 'protocol', column: federatedActors.protocol, absentAs: 'activitypub' },
    { path: 'type', column: federatedActors.type, absentAs: 'Person' },
    // NULLABLE: an actor whose outbox has never been crawled carries no
    // backfill subdocument at all, so the audit's null branch declines it and
    // only a real fifth status is reported.
    { path: 'outboxBackfill.status', column: federatedActors.outboxBackfillStatus },
  ],
  uniquenessAudits: [
    {
      index: 'federated_actors_uri_key',
      key: [{ path: 'uri', normalize: 'exact' }],
      resolvedBy: KEEP_FRESHEST_FEDERATED_ACTOR,
    },
    {
      index: 'federated_actors_acct_key',
      key: [{ path: 'acct', normalize: 'exact' }],
      // The SAME rule answers this one through BOTH its remedies, which is why
      // they are one rule: almost every acct collision is two rows of one `uri`
      // group and is cleared by the drop, and the `handle.invalid` group is
      // cleared by the re-key. Either way `resolvesUniquenessGroup` sees
      // all-but-one of the group acted on.
      //
      // It fails CLOSED for anything else — a NON-sentinel acct shared across
      // distinct `uri`s is two different actors that neither remedy is written
      // for, and that finding still blocks so a human decides.
      resolvedBy: KEEP_FRESHEST_FEDERATED_ACTOR,
    },
    {
      // The pair that a case-only difference would collide on if either side
      // were ever normalized differently. Both are `exact` because neither the
      // Mongo index nor the Postgres one applies a collation — `acct` is
      // already lowercased by the resolver before it is written.
      index: 'federated_actors_domain_username_key',
      key: [
        { path: 'domain', normalize: 'exact' },
        { path: 'username', normalize: 'exact' },
      ],
      resolvedBy: KEEP_FRESHEST_FEDERATED_ACTOR,
    },
  ],
  transform: (doc, emit, resolutions) => {
    const id = ownId(doc);

    const uri = reqStr(doc, 'uri');
    const storedAcct = reqStr(doc, 'acct');
    // REMEDY TWO, checked FIRST and decided from this document alone: an `acct`
    // that is Bluesky's unresolved-handle sentinel identifies nobody, so the row
    // is re-keyed onto its own DID — which for an atproto actor IS its `uri`.
    // The same substitution `atprotoIdentityHandle` now applies at ingest, so
    // the row lands in the shape the fixed writer would have produced.
    //
    // The pre-pass guarantees a sentinel row is never ALSO a `uri` duplicate
    // (it refuses any such group outright), which is what makes checking the
    // sentinel before the drop safe — otherwise a row needing to be dropped
    // would be re-keyed instead and two rows would share a `uri`.
    const sentinelAcct = isUnresolvedAtprotoHandle(storedAcct);
    if (sentinelAcct) {
      resolutions.record({
        rule: KEEP_FRESHEST_FEDERATED_ACTOR,
        documentId: id,
        detail:
          `acct ${JSON.stringify(storedAcct)} is the AppView's error string for a ` +
          'handle that does not verify, not an identity — every such account ' +
          'carries the same one. `acct` and `username` are re-keyed to this ' +
          "row's own DID, which is unique and is what the connector now writes. " +
          'Nothing is dropped.',
        evidence: { uri, acct: storedAcct, username: reqStr(doc, 'username') },
      });
    }

    // A duplicate of an actor another row already carries — decided ONCE by the
    // pre-pass against the whole collection, because "which of these rows is
    // the freshest" is a question about the GROUP and a transform sees one
    // document. Every phase reads that same decision, so the audit, the copy
    // and both verifier passes cannot disagree about which row survives.
    if (!sentinelAcct && resolutions.actedOn.get(KEEP_FRESHEST_FEDERATED_ACTOR.id)?.has(id) === true) {
      resolutions.dropDocument(
        KEEP_FRESHEST_FEDERATED_ACTOR,
        'federatedactors',
        id,
        'Another federatedactors document carries the same `uri` and was ' +
          'fetched more recently, so it is the row the resolver has been ' +
          'keeping current. This one is a duplicate insert from the unindexed ' +
          'concurrent upsert and is dropped; see the rule for why nothing is ' +
          'lost with it.'
      );
      return;
    }

    emit(
      federatedActors,
      buildRow(
        federatedActors,
        {
          id,
          protocol: str(doc, 'protocol') ?? 'activitypub',
          uri,
          // Re-keyed onto the DID for a sentinel row; the stored value verbatim
          // for every other actor, which is all but 21 documents.
          username: sentinelAcct ? uri : reqStr(doc, 'username'),
          domain: reqStr(doc, 'domain'),
          acct: sentinelAcct ? uri : storedAcct,
          summary: str(doc, 'summary'),
          avatarUrl: str(doc, 'avatarUrl'),
          headerUrl: str(doc, 'headerUrl'),
          inboxUrl: str(doc, 'inboxUrl'),
          // The actor's ADVERTISED outbox. `AGENTS.md` is explicit that guessing
          // `actorUri + '/outbox'` breaks PeerTube, Lemmy and some Pleroma, so a
          // missing value must stay NULL rather than being synthesised here —
          // the fallback belongs to the sync path, which knows it is guessing.
          outboxUrl: str(doc, 'outboxUrl'),
          sharedInboxUrl: str(doc, 'sharedInboxUrl'),
          followersUrl: str(doc, 'followersUrl'),
          followingUrl: str(doc, 'followingUrl'),
          publicKeyPem: str(doc, 'publicKeyPem'),
          publicKeyId: str(doc, 'publicKeyId'),
          type: str(doc, 'type') ?? 'Person',
          manuallyApprovesFollowers: bool(doc, 'manuallyApprovesFollowers') ?? false,
          discoverable: bool(doc, 'discoverable') ?? true,
          memorial: bool(doc, 'memorial') ?? false,
          suspended: bool(doc, 'suspended') ?? false,
          featuredUrl: str(doc, 'featuredUrl'),
          featuredTagsUrl: str(doc, 'featuredTagsUrl'),
          alsoKnownAs: strArray(doc, 'alsoKnownAs'),
          remoteCreatedAt: date(doc, 'remoteCreatedAt'),
          followersCount: int(doc, 'followersCount') ?? 0,
          followingCount: int(doc, 'followingCount') ?? 0,
          postsCount: int(doc, 'postsCount') ?? 0,
          // SPARSE in Mongo — only a resolved actor carries one, and NULL is
          // "not yet linked to an Oxy account", which the resolver tests for.
          oxyUserId: str(doc, 'oxyUserId'),
          lastFetchedAt: date(doc, 'lastFetchedAt'),
          // Carried verbatim BECAUSE it is sticky: a stale value makes an empty
          // first sync permanent until it is cleared by hand. Resetting it here
          // would re-crawl every remote actor on the first post-cutover sweep.
          lastOutboxSyncAt: date(doc, 'lastOutboxSyncAt'),

          outboxBackfillStatus: str(doc, 'outboxBackfill.status'),
          outboxBackfillOutboxUrl: str(doc, 'outboxBackfill.outboxUrl'),
          outboxBackfillCursorUrl: str(doc, 'outboxBackfill.cursorUrl'),
          outboxBackfillCursorItemOffset: int(doc, 'outboxBackfill.cursorItemOffset') ?? 0,
          outboxBackfillProcessedCount: int(doc, 'outboxBackfill.processedCount') ?? 0,
          outboxBackfillImportedCount: int(doc, 'outboxBackfill.importedCount') ?? 0,
          outboxBackfillExistingCount: int(doc, 'outboxBackfill.existingCount') ?? 0,
          outboxBackfillPageCount: int(doc, 'outboxBackfill.pageCount') ?? 0,
          // A LEASE, and copied rather than cleared for the same reason the
          // outbox queues' leases are: an expired one is reclaimable by design,
          // and clearing it would let a second worker claim a crawl the old one
          // may still be running.
          outboxBackfillLockedUntil: date(doc, 'outboxBackfill.lockedUntil'),
          outboxBackfillLastRunAt: date(doc, 'outboxBackfill.lastRunAt'),
          outboxBackfillCompletedAt: date(doc, 'outboxBackfill.completedAt'),
          outboxBackfillLastError: str(doc, 'outboxBackfill.lastError'),

          ...timestamps(doc),
        },
        id
      )
    );

    // `fields[]` — the actor's profile metadata rows (the "Website / Pronouns"
    // table Mastodon renders). Inline array, so Mongoose kept an `_id`.
    for (const [field, position] of subdocuments(doc, 'fields')) {
      emit(
        federatedActorFields,
        buildRow(
          federatedActorFields,
          {
            id: childRowId(field, id, 'fields', position),
            actorId: id,
            position,
            // Both are `NOT NULL` here and OPTIONAL in Mongo (`{ type: String }`
            // with no `required`), so a half-written field is possible and
            // becomes a loud `23502` naming the document rather than a row with
            // an empty label. `reqStr` accepts `''` — an empty-but-present value
            // is a value, and Mastodon does render one.
            name: reqStr(field, 'name'),
            value: reqStr(field, 'value'),
            verifiedAt: date(field, 'verifiedAt'),
          },
          id
        )
      );
    }
  },
};

/** `federatedfollows` → `federated_follows`. */
const federatedFollowsPlan: CollectionPlan = {
  collection: 'federatedfollows',
  table: federatedFollows,
  enumAudits: [
    { path: 'direction', column: federatedFollows.direction },
    { path: 'status', column: federatedFollows.status, absentAs: 'pending' },
    { path: 'network', column: federatedFollows.network, absentAs: 'activitypub' },
  ],
  uniquenessAudits: [
    {
      index: 'federated_follows_local_remote_direction_key',
      key: [
        { path: 'localUserId', normalize: 'exact' },
        { path: 'remoteActorUri', normalize: 'exact' },
        { path: 'direction', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    emit(
      federatedFollows,
      buildRow(
        federatedFollows,
        {
          id: ownId(doc),
          localUserId: reqStr(doc, 'localUserId'),
          remoteActorUri: reqStr(doc, 'remoteActorUri'),
          direction: reqStr(doc, 'direction'),
          status: str(doc, 'status') ?? 'pending',
          network: str(doc, 'network') ?? 'activitypub',
          // The AP activity id to Undo. NULL for a follow that predates the
          // field, and the undo path already tolerates that.
          activityId: str(doc, 'activityId'),
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** `federatedmediacaches` → `federated_media_cache`. */
const federatedMediaCachePlan: CollectionPlan = {
  collection: 'federatedmediacaches',
  table: federatedMediaCache,
  enumAudits: [{ path: 'state', column: federatedMediaCache.state, absentAs: 'pending' }],
  numericAudits: [
    {
      path: 'failCount',
      column: federatedMediaCache.failCount,
      constraint: 'federated_media_cache_fail_count_check',
      min: 0,
      absentAs: 0,
    },
  ],
  uniquenessAudits: [
    {
      index: 'federated_media_cache_remote_url_key',
      key: [{ path: 'remoteUrl', normalize: 'exact' }],
    },
  ],
  transform: (doc, emit) => {
    emit(
      federatedMediaCache,
      buildRow(
        federatedMediaCache,
        {
          id: ownId(doc),
          remoteUrl: reqStr(doc, 'remoteUrl'),
          // Oxy file ids, absent until the entry is actually cached. NULL is
          // "not cached", which `decideProxyServe` tests for.
          oxyFileId: str(doc, 'oxyFileId'),
          posterFileId: str(doc, 'posterFileId'),
          contentType: str(doc, 'contentType'),
          sizeBytes: int(doc, 'sizeBytes'),
          state: str(doc, 'state') ?? 'pending',
          cachedAt: date(doc, 'cachedAt'),
          failCount: int(doc, 'failCount') ?? 0,
          nextAttemptAt: date(doc, 'nextAttemptAt'),
          // `NOT NULL DEFAULT now()`, and it drives the EVICTION sweep — an
          // absent one is omitted so Postgres supplies the default rather than
          // this plan inventing an access time that would postpone eviction.
          ...optionalDate(doc, 'lastAccessedAt', 'lastAccessedAt'),
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/**
 * `federationdeliveryqueues` → `federation_delivery_queue`.
 *
 * The LEGACY queue. Outbound delivery moved to BullMQ and this table exists to
 * drain what was written before that, with `migrated_to_bullmq` marking rows
 * already handed over so a restart cannot enqueue the same delivery twice.
 *
 * It is copied rather than excluded precisely BECAUSE of that flag: an
 * unmigrated row still represents an undelivered activity, and dropping the
 * table would lose it silently. A row whose flag is set is equally load-bearing
 * in the other direction — losing it would let the same activity be enqueued a
 * second time.
 */
const federationDeliveryQueuePlan: CollectionPlan = {
  collection: 'federationdeliveryqueues',
  table: federationDeliveryQueue,
  enumAudits: [
    { path: 'status', column: federationDeliveryQueue.status, absentAs: 'pending' },
  ],
  numericAudits: [
    {
      path: 'attempts',
      column: federationDeliveryQueue.attempts,
      constraint: 'federation_delivery_queue_attempts_check',
      min: 0,
      absentAs: 0,
    },
  ],
  transform: (doc, emit) => {
    emit(
      federationDeliveryQueue,
      buildRow(
        federationDeliveryQueue,
        {
          id: ownId(doc),
          // A whole ActivityStreams document of arbitrary shape — one of the two
          // legitimate `jsonb` columns in this schema. Required with no default,
          // so a row without one is a loud failure: a delivery with no activity
          // has nothing to deliver.
          activityJson: reqJsonObject(doc, 'activityJson'),
          targetInbox: reqStr(doc, 'targetInbox'),
          senderOxyUserId: reqStr(doc, 'senderOxyUserId'),
          attempts: int(doc, 'attempts') ?? 0,
          lastAttemptAt: date(doc, 'lastAttemptAt'),
          status: str(doc, 'status') ?? 'pending',
          error: str(doc, 'error'),
          // Mongo stored ABSENT or a boolean; every reader tests truthiness.
          // `?? false` is the faithful port, and getting it wrong in the other
          // direction would re-enqueue an already-migrated delivery.
          migratedToBullmq: bool(doc, 'migratedToBullmq') ?? false,
          // `NOT NULL` with NO default — the only date in these plans that
          // cannot be omitted. It is the backoff gate the drain query orders
          // on, so there is nothing safe to substitute: an invented value
          // changes when this delivery runs. `reqDate` throws naming the path
          // and the `_id`, which is what an operator needs to decide whether
          // the row is still drainable.
          nextAttemptAt: reqDate(doc, 'nextAttemptAt'),
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** Every federation plan. */
export const FEDERATION_PLANS: readonly CollectionPlan[] = [
  actorKeyPairsPlan,
  federatedActorsPlan,
  federatedFollowsPlan,
  federatedMediaCachePlan,
  federationDeliveryQueuePlan,
];
