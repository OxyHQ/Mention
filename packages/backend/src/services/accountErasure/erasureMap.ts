/**
 * THE ERASURE MAP: every column in Mention's own database that can hold an Oxy
 * account id, and what erasing that account does to it.
 *
 * WHY THIS IS DATA
 *
 * A hand-written erasure goes stale the day somebody adds a table. The failure is
 * silent: the new table keeps rows naming a person who asked to be forgotten, and
 * nothing ever throws. So the erasure is written as data and
 * `__tests__/services/accountErasureCoverage.test.ts` compares it against the real
 * drizzle schema. A new table with an account column fails that test on the commit
 * that adds it, and the failure names the column. The same test fails when an
 * executable entry has no step in `erasureSteps.ts`, or a step exists for no
 * entry. The map IS the program, the same design as the channel-deletion
 * manifest (`services/channelDeletion/channelCascadeManifest.ts`).
 *
 * WHICH COLUMNS COUNT AS "AN ACCOUNT COLUMN"
 *
 * Three sources, and the gate reads all of them:
 *  1. `isOxyAccountColumn` (`db/schema/deferredForeignKeys.ts`), the one predicate
 *     the schema uses to classify every Oxy-account id column.
 *  2. {@link ACCOUNT_REFERENCE_EXTRAS}: account ids under names the predicate does
 *     not know (`lanes.owner_id`, array columns, polymorphic ids).
 *  3. A name heuristic in the test (`user`, `owner`, `author`, `actor`, `_by`, …)
 *     that over-collects on purpose. Everything it finds is either in this map
 *     or in {@link NOT_AN_ACCOUNT_COLUMN} with a written reason.
 *
 * HOW TO READ AN ENTRY
 *
 * `disposition` says what happens to a row that names the erased account, and
 * `why` says why this and not the alternative. Where a row is KEPT, it is kept
 * without the account id in it (`anonymise`, `unset-field`, `pull-from-array`)
 * unless it is `retain`, and every `retain` names the obligation that keeps it.
 */

/** What erasing an account does to a row that names it. */
export type ErasureDisposition =
  /** The row exists because of the account; it goes. */
  | 'delete-row'
  /** One entry in somebody else's structure (a list membership, a vote). The entry goes; the parent stays. */
  | 'delete-entry'
  /** One element of an array column on somebody else's row. */
  | 'pull-from-array'
  /** A pointer on somebody else's row, set to NULL. Their row keeps its content. */
  | 'unset-field'
  /**
   * The row is someone else's record and must survive, but the column cannot be
   * NULL. The account id is replaced with {@link ERASED_ACCOUNT_SENTINEL}, which
   * can never be an Oxy id.
   */
  | 'anonymise'
  /** A managed MTN vault is marked `revoked` so the node fleet tears its volume down. */
  | 'revoke'
  /** An `ON DELETE` constraint does it when a parent row this erasure deletes goes. No step. */
  | 'database'
  /** Deliberately kept, with the obligation named in `why`. No step. */
  | 'retain';

/**
 * The phase a step runs in. The order is the design, and it is set by what each
 * step READS before something else deletes it:
 *
 *  - `drain` cancels the account's queued outbound activities, so a queued
 *    `Create` cannot race the `Delete`s about to be sent.
 *  - `posts` is the keyset walk over the account's posts: `Delete(Note)` to
 *    followers, the reference legs, the counters on surviving posts, the rows.
 *  - The actor `Delete` is sent between `posts` and `engagement`, while the
 *    `federated_follows` rows it resolves inboxes from still exist.
 *  - `engagement` removes the account's likes, saves and votes, and repairs the
 *    counters on the surviving posts they were counted on, in the same statement.
 *  - `account` is everything else keyed on the account.
 *  - `federation` is last: the follow edges and actor rows the actor `Delete`
 *    needed.
 */
export type ErasurePhase = 'drain' | 'posts' | 'engagement' | 'account' | 'federation';

export interface ErasureMapEntry {
  /** SQL table name, exactly as `getTableName` answers. */
  readonly table: string;
  /** Drizzle column PROPERTY name, exactly as `Object.keys(getTableColumns(t))` answers. */
  readonly column: string;
  readonly disposition: ErasureDisposition;
  /** Absent for `database` and `retain`, which have no step. */
  readonly phase?: ErasurePhase;
  /** Why this disposition. Read by humans; `docs/account-erasure.md` is generated from nothing, so keep both in step. */
  readonly why: string;
}

/**
 * What an anonymised account column holds instead of the id. It contains a colon,
 * which no Oxy id (ObjectId hex or uuid v7) does, so it can never resolve to a
 * person. `reports.reporter` gets a per-row variant (`erased:<report id>`) because
 * that column is part of a unique key.
 */
export const ERASED_ACCOUNT_SENTINEL = 'erased:account';

/** The map's identity for an entry. A column never appears twice. */
export function erasureKey(entry: Pick<ErasureMapEntry, 'table' | 'column'>): string {
  return `${entry.table}.${entry.column}`;
}

export const ACCOUNT_ERASURE_MAP: readonly ErasureMapEntry[] = [
  // ---------------------------------------------------------------------------
  // drain
  // ---------------------------------------------------------------------------
  {
    table: 'federation_delivery_queue',
    column: 'senderOxyUserId',
    disposition: 'delete-row',
    phase: 'drain',
    why:
      'Outbound activities the account queued. Cancelled BEFORE the Deletes go out, or a queued Create ' +
      'races them and republishes a post on the receiving server. Rows carrying a `Delete` are spared, ' +
      'so a re-run never cancels the Deletes an earlier attempt queued.',
  },

  // ---------------------------------------------------------------------------
  // posts: the keyset walk
  // ---------------------------------------------------------------------------
  {
    table: 'posts',
    column: 'oxyUserId',
    disposition: 'delete-row',
    phase: 'posts',
    why:
      "The account's posts, replies, boosts, quotes, drafts and scheduled posts. Walked in keyset batches; " +
      'each batch sends `Delete(Note)`, runs `PostDeletionCascade.cascadePostReferences`, repairs counters ' +
      'on surviving posts and deletes the rows in one transaction. Other people\'s BOOSTS of these posts go ' +
      "with them (`boost_of` cascades; a boost is an empty card). Other people's REPLIES and QUOTES stay: " +
      'they wrote those words. `parent_post_id`/`quote_of` become NULL and `is_reply` stays true, so an ' +
      'orphaned reply is never promoted into a root feed.',
  },
  {
    table: 'post_authorships',
    column: 'oxyUserId',
    disposition: 'delete-entry',
    phase: 'account',
    why:
      "Owner entries go with the account's own posts. What is left is the account as a COLLABORATOR on " +
      "someone else's post (or a pending invite): the entry goes, the owner's post stays.",
  },
  {
    table: 'posts',
    column: 'writtenByOxyUserId',
    disposition: 'unset-field',
    phase: 'account',
    why:
      'The account as the human WRITER of a channel post. The post is the channel\'s and stays; the pointer ' +
      'to the person goes. NULL is the same state as a channel post written before writers were recorded.',
  },
  {
    table: 'posts',
    column: 'contentRoomHost',
    disposition: 'unset-field',
    phase: 'account',
    why:
      "The account as the host of a live room shared in someone else's post. The post stays; the host " +
      'pointer goes. On the account\'s own posts it goes with the row.',
  },
  {
    table: 'post_corrections',
    column: 'correctedByOxyUserId',
    disposition: 'anonymise',
    phase: 'account',
    why:
      "Corrections the account made to someone else's (a channel's) post. The correction trail is that " +
      'post\'s public history and stays; it never serves who corrected it, and the column is NOT NULL, so ' +
      'the id is replaced by the sentinel. Corrections on the account\'s own posts go with the posts.',
  },
  {
    table: 'post_imports',
    column: 'oxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why:
      'The import ledger for posts the account brought in with Oxy Move. Rows cascade with their posts; ' +
      'the step removes any row whose post was already gone.',
  },
  {
    table: 'post_mentions',
    column: 'oxyUserId',
    disposition: 'delete-entry',
    phase: 'account',
    why:
      "Other people's posts that mention the account. The mention link goes; their text stays theirs.",
  },
  {
    table: 'post_recent_repliers',
    column: 'oxyUserId',
    disposition: 'delete-entry',
    phase: 'engagement',
    why:
      "A denormalized avatar strip on someone else's post. The entry goes and the strip is recomputed from " +
      'the surviving replies, so the next replier takes the slot.',
  },
  {
    table: 'post_subscriptions',
    column: 'subscriberId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'The account\'s "notify me when X posts" subscriptions.',
  },
  {
    table: 'post_subscriptions',
    column: 'authorId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Other people\'s subscriptions to the account. There is nothing left to be notified about.',
  },
  {
    table: 'polls',
    column: 'createdBy',
    disposition: 'delete-row',
    phase: 'account',
    why:
      "Polls cascade with the account's posts; the step catches any poll the account created on a post " +
      'that was not theirs. Options and votes cascade from the poll.',
  },
  {
    table: 'articles',
    column: 'createdBy',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Long-form bodies. Cascade with the posts; the step catches any left behind.',
  },
  {
    table: 'postgates',
    column: 'createdBy',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Quote gates the account set. A gate belongs to its creator.',
  },
  {
    table: 'threadgates',
    column: 'createdBy',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Reply gates the account set.',
  },

  // ---------------------------------------------------------------------------
  // engagement: removed with the counters they were counted on
  // ---------------------------------------------------------------------------
  {
    table: 'likes',
    column: 'userId',
    disposition: 'delete-row',
    phase: 'engagement',
    why:
      "The account's likes and downvotes. Each batch is deleted and the like/downvote counters on the " +
      'surviving posts are decremented by exactly what was deleted, in ONE statement, so a crash between ' +
      'the two cannot double-count on a retry. The counts become anonymous totals.',
  },
  {
    table: 'bookmarks',
    column: 'userId',
    disposition: 'delete-row',
    phase: 'engagement',
    why: 'The account\'s saves, with `stats_saves_count` repaired in the same statement.',
  },
  {
    table: 'poll_votes',
    column: 'userId',
    disposition: 'delete-entry',
    phase: 'engagement',
    why:
      "The account's votes on other people's polls. Tallies are computed from the vote rows, so removing the " +
      'vote is the whole repair.',
  },
  {
    table: 'feed_interactions',
    column: 'userId',
    disposition: 'delete-row',
    phase: 'engagement',
    why: 'Ranking telemetry about what the account saw and did. Personal behavioural data; batched.',
  },

  // ---------------------------------------------------------------------------
  // account: settings, graph, lists, feeds, notifications
  // ---------------------------------------------------------------------------
  {
    table: 'user_settings',
    column: 'oxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why:
      'Appearance, privacy, profile design, notification and feed settings: what `GET /profile/design/:id` ' +
      'served in the issue. Label actions cascade.',
  },
  {
    table: 'user_settings',
    column: 'privacyRestrictedUsers',
    disposition: 'pull-from-array',
    phase: 'account',
    why: "Someone else's settings naming the account as restricted. Their row is theirs; the entry goes.",
  },
  {
    table: 'user_feed_preferences',
    column: 'oxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Saved and pinned feeds. `user_saved_feeds` cascades.',
  },
  {
    table: 'user_behaviors',
    column: 'oxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'The ranking profile inferred from the account\'s behaviour. Its author/topic/region rows cascade.',
  },
  {
    table: 'user_behavior_authors',
    column: 'authorId',
    disposition: 'delete-entry',
    phase: 'account',
    why: "The account as an affinity entry in someone else's ranking profile.",
  },
  {
    table: 'user_behaviors',
    column: 'hiddenAuthors',
    disposition: 'pull-from-array',
    phase: 'account',
    why: "The account inside someone else's hidden-authors list.",
  },
  {
    table: 'user_behaviors',
    column: 'mutedAuthors',
    disposition: 'pull-from-array',
    phase: 'account',
    why: "The account inside someone else's muted-authors list.",
  },
  {
    table: 'user_behaviors',
    column: 'blockedAuthors',
    disposition: 'pull-from-array',
    phase: 'account',
    why: "The account inside someone else's blocked-authors list.",
  },
  {
    table: 'author_follower_snapshots',
    column: 'oxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Follower-count samples used for the rising-creators signal.',
  },
  {
    table: 'mutes',
    column: 'userId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Who the account muted.',
  },
  {
    table: 'mutes',
    column: 'mutedId',
    disposition: 'delete-entry',
    phase: 'account',
    why: 'Other people muting the account. Nothing is left to mute.',
  },
  {
    table: 'mute_words',
    column: 'userId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'The account\'s muted words.',
  },
  {
    table: 'pokes',
    column: 'pokerId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Pokes the account sent.',
  },
  {
    table: 'pokes',
    column: 'pokedId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Pokes the account received.',
  },
  {
    table: 'entity_follows',
    column: 'userId',
    disposition: 'delete-row',
    phase: 'account',
    why:
      'Hashtags and lists the account follows. Other people\'s follows of the account\'s LISTS are removed ' +
      'with the lists, before the list rows go.',
  },
  {
    table: 'notifications',
    column: 'recipientId',
    disposition: 'delete-row',
    phase: 'account',
    why: "The account's inbox.",
  },
  {
    table: 'notifications',
    column: 'actorId',
    disposition: 'delete-row',
    phase: 'account',
    why:
      "Notifications the account caused in other people's inboxes. \"X liked your post\" names a person who " +
      'asked to be forgotten, so it goes.',
  },
  {
    table: 'notifications',
    column: 'entityId',
    disposition: 'delete-row',
    phase: 'account',
    why:
      'Notifications ABOUT the account as a profile (`entity_type = profile`). Post-typed ones go with the ' +
      'posts, through `cascadePostReferences`.',
  },
  {
    table: 'push_tokens',
    column: 'userId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Device push tokens. A token outliving its account could still receive pushes.',
  },
  {
    table: 'account_lists',
    column: 'ownerOxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why:
      "The account's lists. Members and feed sources cascade; other people's follows of these lists are " +
      'deleted first because `entity_follows.entity_id` has no foreign key.',
  },
  {
    table: 'account_list_members',
    column: 'oxyUserId',
    disposition: 'delete-entry',
    phase: 'account',
    why: "The account as a member of someone else's list.",
  },
  {
    table: 'starter_packs',
    column: 'ownerOxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why: "The account's starter packs. Members and uses cascade.",
  },
  {
    table: 'starter_pack_members',
    column: 'oxyUserId',
    disposition: 'delete-entry',
    phase: 'account',
    why: "The account inside someone else's starter pack.",
  },
  {
    table: 'starter_pack_uses',
    column: 'oxyUserId',
    disposition: 'delete-entry',
    phase: 'account',
    why:
      'The record that the account used a pack. `use_count` is a lifetime tally and stays an anonymous count.',
  },
  {
    table: 'custom_feeds',
    column: 'ownerOxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why: "The account's custom feeds. Modules, members, sources, topics, likes and reviews cascade.",
  },
  {
    table: 'custom_feed_members',
    column: 'oxyUserId',
    disposition: 'delete-entry',
    phase: 'account',
    why: "The account as a source in someone else's custom feed.",
  },
  {
    table: 'feed_likes',
    column: 'userId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Feeds the account liked or subscribed to.',
  },
  {
    table: 'feed_reviews',
    column: 'reviewerId',
    disposition: 'delete-row',
    phase: 'account',
    why:
      "The account's reviews of other people's feeds, including the text. A feed's stored average rating is " +
      'an anonymous aggregate and is left as it is.',
  },
  {
    table: 'feed_generators',
    column: 'createdBy',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Feed generators the account created.',
  },
  {
    table: 'labelers',
    column: 'creatorId',
    disposition: 'delete-row',
    phase: 'account',
    why:
      'Labelers the account created, with their label definitions and every label they applied (both ' +
      'cascade). An OFFICIAL labeler is Mention\'s moderation infrastructure, not the person\'s: it is kept ' +
      'and its creator is anonymised instead.',
  },
  {
    table: 'content_labels',
    column: 'createdBy',
    disposition: 'anonymise',
    phase: 'account',
    why:
      "Labels the account applied through a labeler that is not theirs (a moderator's work under an " +
      'official labeler). The label is a moderation outcome on content and stays; who applied it goes. ' +
      "Labels under the account's own labelers were already removed with those labelers.",
  },
  {
    table: 'content_labels',
    column: 'targetId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Labels ON the account as a user (`target_type = user`). Post labels go with the posts.',
  },
  {
    table: 'lanes',
    column: 'ownerId',
    disposition: 'delete-row',
    phase: 'account',
    why: "A publisher's lanes. Posts that pointed at them are already gone; `lane_mutes.lane_id` cascades.",
  },
  {
    table: 'lane_mutes',
    column: 'laneOwnerOxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why: "Other people's mutes of the account's lanes.",
  },
  {
    table: 'lane_mutes',
    column: 'viewerOxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Lanes the account muted.',
  },
  {
    table: 'trending',
    column: 'actorIds',
    disposition: 'pull-from-array',
    phase: 'account',
    why:
      'A trend row naming the account among its contributors. The trend belongs to the term and survives ' +
      'with one fewer actor; its `author_count` is an anonymous total.',
  },
  {
    table: 'engagement_outbox',
    column: 'payloadActorOxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Queued side effects (MTN record, notification, federation) of the account\'s own likes.',
  },
  {
    table: 'engagement_outbox',
    column: 'payloadPostOwnerOxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Queued notifications to the account about likes on its posts.',
  },
  {
    table: 'endorsement_outbox',
    column: 'pendingRemoveOwnerId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'A queued endorsement retraction naming the account as owner.',
  },
  {
    table: 'endorsement_outbox',
    column: 'pendingRemoveMemberIds',
    disposition: 'pull-from-array',
    phase: 'account',
    why: "The account inside another scope's pending-removal list.",
  },
  {
    table: 'mcp_connections',
    column: 'oxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Claude/ChatGPT connector sessions. A connection outliving its account is a live credential.',
  },
  {
    table: 'mcp_connections',
    column: 'activeOxyUserId',
    disposition: 'unset-field',
    phase: 'account',
    why:
      "Someone else's bundled connector whose ACTIVE account is this one. Their connection stays; " +
      '`mcpBundleService` falls back to the owner when the pointer is NULL.',
  },
  {
    table: 'mcp_auth_codes',
    column: 'oxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Short-lived OAuth codes.',
  },
  {
    table: 'mcp_effect_receipts',
    column: 'oxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Hash-only dedupe receipts for MCP writes. Operational state, not audit.',
  },
  {
    table: 'mention_jobs',
    column: 'employerOxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why:
      'Jobs published under the account (an organization or project account being deleted). Applications, ' +
      'their answers and notes, and daily metrics cascade.',
  },
  {
    table: 'mention_jobs',
    column: 'authorOxyUserId',
    disposition: 'anonymise',
    phase: 'account',
    why:
      "The account as the operator who created an employer's job. The job is the employer's and stays; " +
      'the column is a NOT NULL audit field, so the id becomes the sentinel.',
  },
  {
    table: 'mention_job_applications',
    column: 'applicantOxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why:
      "The account's job applications: display name, contact method, resume file id, cover note, answers. " +
      "Personal data submitted by the person; it goes, and with it the employer's notes on it (cascade).",
  },
  {
    table: 'mention_job_applications',
    column: 'assignedToOxyUserId',
    disposition: 'unset-field',
    phase: 'account',
    why: "The account as the reviewer an employer's application is assigned to. Unassigned, not deleted.",
  },
  {
    table: 'mention_job_application_notes',
    column: 'authorOxyUserId',
    disposition: 'anonymise',
    phase: 'account',
    why:
      "Internal notes the account wrote as an employer's operator about an applicant. They are the " +
      "employer's hiring record and stay; the author becomes the sentinel.",
  },
  {
    table: 'reports',
    column: 'reporter',
    disposition: 'anonymise',
    phase: 'account',
    why:
      'Reports the account FILED. One that never reached CrowdSource is deleted (its outbox row cascades). ' +
      'One that did stays, because an inbound CrowdSource decision is matched to it and a missing row makes ' +
      'the decision retry until it expires; the reporter becomes `erased:<report id>` (unique per row, as ' +
      'the unique key needs) and the free-text details are cleared.',
  },
  {
    table: 'reports',
    column: 'reportedId',
    disposition: 'retain',
    why:
      'Reports OTHER people filed about the account or its posts. Moderation records: kept for the ' +
      'establishment and defence of moderation decisions (GDPR Art. 17(3)(e); DSA record-keeping). They ' +
      "hold ids, the reporter's categories and a content hash, never the reported content.",
  },
  {
    table: 'moderation_enforcements',
    column: 'subjectId',
    disposition: 'retain',
    why:
      'Enforcement actions taken against the ACCOUNT (`subject_type = user`, e.g. a suspension), kept as ' +
      'moderation records for the same reason as `reports.reportedId`. Enforcements on its POSTS are ' +
      'deleted by the post walk, with the posts.',
  },
  {
    table: 'blocklist_proposals',
    column: 'decidedBy',
    disposition: 'anonymise',
    phase: 'account',
    why:
      'A staff member\'s decision on a federation blocklist proposal. The decision is an audit record and ' +
      'stays; "a person decided" survives as the sentinel.',
  },

  // ---------------------------------------------------------------------------
  // MTN signed records
  // ---------------------------------------------------------------------------
  {
    table: 'mention_signed_records',
    column: 'oxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why:
      "The account's whole signed-record chain, deleted rather than tombstoned. A tombstone is an appended " +
      'record that leaves the superseded envelope (the post text) in the chain, which is not erasure. Every ' +
      'reader of the chain reads THIS table (the atproto bridge, the node export), so deleting the rows ' +
      'removes the records from every surface Mention serves. The channel cascade makes the same call.',
  },
  {
    table: 'mention_repo_heads',
    column: 'oxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why: "The chain head. Its `subject_did` embeds the account id.",
  },
  {
    table: 'mention_node_ingest_witnesses',
    column: 'oxyUserId',
    disposition: 'delete-row',
    phase: 'account',
    why: 'Counter-signatures over records ingested from the account\'s node.',
  },
  {
    table: 'mention_user_nodes',
    column: 'oxyUserId',
    disposition: 'revoke',
    phase: 'account',
    why:
      "The account's MTN node registration. A self-hosted node row is deleted: the node and its copy are the " +
      "person's own server. A MANAGED vault (`controller = oxy`) is marked `revoked` instead, because " +
      'that row is the documented signal the node-fleet reconciler tears the per-user volume down from; ' +
      'deleting it would strand the data.',
  },

  // ---------------------------------------------------------------------------
  // federation: last, after the actor Delete
  // ---------------------------------------------------------------------------
  {
    table: 'federated_follows',
    column: 'localUserId',
    disposition: 'delete-row',
    phase: 'federation',
    why:
      'Follow edges between the account and remote actors. Deleted AFTER the actor Delete, which resolves ' +
      'its inboxes from them.',
  },
  {
    table: 'federated_identity_links',
    column: 'oxyUserId',
    disposition: 'delete-row',
    phase: 'federation',
    why: 'Cross-network identity links. Their evidence rows cascade.',
  },
  {
    table: 'federated_actors',
    column: 'oxyUserId',
    disposition: 'delete-row',
    phase: 'federation',
    why: 'An actor row bound to the account. Profile fields cascade.',
  },
  {
    table: 'federated_actor_fields',
    column: 'actorId',
    disposition: 'database',
    why:
      'Named `actor_id` but it is a `federated_actors.id`, not an account id. `ON DELETE CASCADE` from the ' +
      'actor row above.',
  },
  {
    table: 'actor_key_pairs',
    column: 'oxyUserId',
    disposition: 'delete-row',
    phase: 'federation',
    why:
      'Legacy local key material. Outbound signing is done by Oxy (`POST /federation/sign`), so the Deletes ' +
      'do not need this row, and it goes last regardless.',
  },

  // ---------------------------------------------------------------------------
  // the ledger itself
  // ---------------------------------------------------------------------------
  {
    table: 'account_erasures',
    column: 'oxyUserId',
    disposition: 'retain',
    why:
      'The erasure ledger: the idempotency key for Oxy\'s at-least-once events and the proof the erasure ' +
      'ran. It holds the id, the event id and per-table COUNTS, never content. Its temporary `username` ' +
      'is cleared 14 days after completion.',
  },
];

/**
 * Account ids under names `isOxyAccountColumn` does not recognise. The gate
 * treats these exactly like predicate columns: each must be in the map.
 */
export const ACCOUNT_REFERENCE_EXTRAS: ReadonlyMap<string, string> = new Map([
  ['lanes.ownerId', 'a lane publisher, named `owner_id`'],
  ['lane_mutes.viewerOxyUserId', 'the viewer who muted a lane'],
  ['lane_mutes.laneOwnerOxyUserId', 'the publisher of a muted lane'],
  ['trending.actorIds', 'a `text[]` of contributing accounts'],
  ['user_behaviors.hiddenAuthors', 'a `text[]` of accounts'],
  ['user_behaviors.mutedAuthors', 'a `text[]` of accounts'],
  ['user_behaviors.blockedAuthors', 'a `text[]` of accounts'],
  ['user_settings.privacyRestrictedUsers', 'a `text[]` of accounts'],
  ['endorsement_outbox.pendingRemoveMemberIds', 'a `text[]` of accounts'],
  ['notifications.entityId', 'an account id when `entity_type = profile`'],
  ['content_labels.targetId', 'an account id when `target_type = user`'],
  ['reports.reportedId', 'an account id when `reported_type = user`'],
  ['blocklist_proposals.decidedBy', 'the staff account that decided'],
  ['posts.contentRoomHost', 'the account hosting a live room attached to a post'],
  ['moderation_enforcements.subjectId', 'an account id when `subject_type = user`'],
]);

/**
 * Columns the name heuristic in the coverage test flags that do NOT hold an Oxy
 * account id, each with what it does hold. Dismissed once, here, in writing.
 */
export const NOT_AN_ACCOUNT_COLUMN: ReadonlyMap<string, string> = new Map([
  ['posts.contentPodcastAuthor', 'the display name of a podcast\'s author from Syra\'s catalog'],
  ['user_settings.profileMediaAuthor', 'the display name of a podcast\'s author from Syra\'s catalog'],
  ['posts.metadataAuthorBlocked', 'a boolean flag on the post'],
  ['posts.metadataAuthorMuted', 'a boolean flag on the post'],
  ['posts.metadataIsFollowingAuthor', 'a boolean flag on the post'],
  ['user_settings.feedMaxConsecutiveSameAuthor', 'a feed tuning number'],
  ['blocked_domain_purge_runs.removedActors', 'a count'],
  ['blocked_domain_purges.measuredActors', 'a count'],
  ['blocklist_proposals.footprintActors', 'a count'],
  ['blocklist_proposal_runs.countsSuppressedBlocked', 'a count'],
  ['blocklist_proposal_observations.operator', "a remote instance operator's domain"],
  ['blocklist_proposal_run_sources.operator', "a remote instance operator's domain"],
  ['engagement_outbox.leaseOwner', 'the id of the worker process holding a lease'],
  ['moderation_outbox.leaseOwner', 'the id of the worker process holding a lease'],
]);

/**
 * References no column-level map can reach: inside a string or a `jsonb` blob.
 * Each says whether the erasure reaches it and why that is enough.
 */
export const EMBEDDED_ACCOUNT_REFERENCES: ReadonlyMap<string, string> = new Map([
  [
    'mention_signed_records.envelope / .subject_did / mention_repo_heads.subject_did',
    'The DID embeds the account id. REACHED: the rows are deleted by `oxy_user_id`.',
  ],
  [
    'federation_delivery_queue.activity_json',
    'The account\'s actor URL inside queued activities. REACHED for the account\'s own rows (drained by ' +
      'sender); the `Delete` rows this erasure queues keep the actor URL, which is what a Delete must name.',
  ],
  [
    'feed_interactions.feed_descriptor / user_saved_feeds.descriptor / likes.source',
    "Other people's telemetry and saved feeds can embed `author|<account id>`. NOT REACHED: a provenance " +
      'label, not a pointer; it resolves to nothing once the account is gone and holds no personal content.',
  ],
  [
    'custom_feed_definition_modules.params.authorIds',
    "Someone else's feed module can pin the account by id inside a module-defined blob. NOT REACHED for " +
      'the same reason: the source resolves the id through the author path, which returns nothing.',
  ],
  [
    'moderation_events.payload / moderation_outbox.payload_decision',
    'A CrowdSource decision names its subject inside a deliberately loose payload. NOT REACHED; it resolves ' +
      'against the retained `reports` rows (see `reports.reportedId`).',
  ],
  [
    "posts content (other people's text)",
    "Other people's posts may contain the account's @handle as text. NOT REACHED: that text is their " +
      'writing. The structured link (`post_mentions`) is removed.',
  ],
]);

/**
 * Where data about the account lives OUTSIDE Mention's database, and who erases it.
 */
export const OUTSIDE_THE_MAP: ReadonlyMap<string, string> = new Map([
  [
    'Oxy (identity, graph, blocks, uploaded media bytes, federation signing keys)',
    'Oxy owns the account, follow/block edges, and every uploaded file (post media are bare Oxy file ids), ' +
      'so erasing them is `DELETE /users/me`, not Mention. Oxy keeps the federation key pair so the actor ' +
      'Delete can still be signed.',
  ],
  [
    'Remote fediverse servers',
    'Told with a signed `Delete` for each public post and a `Delete` of the actor. They are asked, not ' +
      'forced: a server may ignore it, and a server that was down past the delivery retry budget never ' +
      'hears it.',
  ],
  [
    'CrowdSource (delivered reports, community notes and ratings)',
    "CrowdSource holds what was delivered to it under the account's id. Mention has no erasure call into " +
      'CrowdSource today; that is CrowdSource\'s to erase and is tracked as a follow-up.',
  ],
  [
    'A self-hosted MTN node',
    "The person's own server holding their own copy. Mention stops syncing with it; it cannot and should " +
      'not reach into it.',
  ],
  [
    'Redis caches',
    'Per-account keys (user summary, fediverse-sharing flag, viewer relations, seen posts, recent topics) ' +
      'are deleted by the job. Keys that cannot be enumerated by account (per-post view markers, search ' +
      'overview, anonymous feed pages) expire on their own TTL, at most 24 hours.',
  ],
]);
