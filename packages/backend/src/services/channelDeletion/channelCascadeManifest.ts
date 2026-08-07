/**
 * The complete, enumerated inventory of everything in Mention's own database
 * that points at a channel account or at a post a channel authored.
 *
 * WHY THIS IS A DATA STRUCTURE AND NOT A FUNCTION
 *
 * A hand-written cascade goes stale the day somebody adds a table, and it fails
 * SILENTLY: the new table keeps rows pointing at a channel that no longer
 * exists, nothing throws, and nobody finds out for months. So the cascade is
 * expressed as data that a test can compare against the real schema —
 * `src/__tests__/services/channelCascadeCoverage.test.ts` enumerates
 * `src/db/schema` with drizzle's OWN reflection (`is(v, PgTable)`,
 * `getTableName`, `getTableColumns`), extracts every id-shaped column, and fails
 * when one is not classified here. A new table with a `postId` breaks that test
 * on the commit that adds it, which is the only mechanism that keeps this
 * honest.
 *
 * WHY THE GATE READS THE SCHEMA OBJECT AND NOT `src/models/*.ts`
 *
 * It used to scan the Mongoose model tree with a regex. Post-cutover that tree
 * is the ABANDONED store — a check pointed at it can only ever describe rows
 * nothing reads, and it passes forever however wrong the cascade becomes. The
 * drizzle table objects are the thing that generates BOTH the migrations and the
 * queries, so a manifest compared against them cannot desync from what the
 * database actually holds.
 *
 * Every id-shaped column in every table is in EXACTLY ONE of two places:
 *   - {@link CHANNEL_CASCADE} — it references a channel or a channel's post, and
 *     this is what happens to it.
 *   - {@link NOT_A_CHANNEL_REFERENCE} — the id names something that is neither an
 *     Oxy account nor a Mention post (a topic, a feed, a run, a file, a
 *     CrowdSource case), with the reason.
 *
 * Two further lists carry what a column-level enumeration structurally cannot:
 * {@link EMBEDDED_CHANNEL_REFERENCES} (references inside a string or a `jsonb`
 * blob, which no column name reaches) and {@link OWNED_BY_OXY} (real references
 * Mention cannot delete because the row lives on Oxy's side of the boundary).
 *
 * THE MANIFEST IS THE PROGRAM
 *
 * The cascade EXECUTES this list (see `ChannelDeletionService`), rather than
 * describing something implemented separately. That is deliberate — a manifest
 * that merely documents a hand-written cascade is a second thing to keep in
 * sync, and the two would drift in exactly the direction nobody notices.
 *
 * THE CASCADE IS SMALLER THAN THE MANIFEST, AND THAT IS THE POINT
 *
 * A large part of this inventory is now performed by POSTGRES: thirteen child
 * tables of `posts` are `ON DELETE CASCADE`, `posts.boost_of` is a SELF-cascade,
 * and `quote_of` / `parent_post_id` / `thread_id` / `lane_id` are
 * `ON DELETE SET NULL`. Those entries carry the {@link CascadeAction}
 * `'database'` and there is no leg for them, deliberately: a leg would
 * re-implement work the database has already done, and it would be
 * PERMANENTLY UNTESTABLE, because every residue check runs after the delete when
 * the rows are gone either way and cannot tell "my leg ran" from "the FK ran".
 * Do not "complete" the cascade by adding them back.
 *
 * What is left is exactly the shape a foreign key cannot express, and it is
 * where all the real work is: **everything keyed on an Oxy account id.** Oxy
 * owns identity, so every `oxy_user_id` / `user_id` / `actor_id` /
 * `owner_oxy_user_id` in this schema is a foreign service's primary key held in
 * a plain `text()` column with no constraint (`db/schema/deferredForeignKeys.ts`
 * classifies every one of them). Postgres cannot cascade any of it.
 */

/** What happens to a row that carries the reference. */
export type CascadeAction =
  /** The row exists only because of the channel or its post; it dies with it. */
  | 'delete-row'
  /**
   * The row is ONE ENTRY inside somebody else's structure — a junction or child
   * row whose parent belongs to a third party. The entry goes and the parent row
   * survives intact. This is what `$pull` from an array of ids meant before the
   * arrays were normalized into tables; the policy did not change, only the
   * storage.
   */
  | 'delete-entry'
  /**
   * One element of an ARRAY COLUMN on somebody else's row. Same policy as
   * `delete-entry`; the arrays that were NOT normalized keep the array
   * operation.
   */
  | 'pull-from-array'
  /** A pointer on somebody else's row, set to NULL. Their row keeps its content. */
  | 'unset-field'
  /**
   * PERFORMED BY POSTGRES — an `ON DELETE CASCADE` or `ON DELETE SET NULL`
   * constraint removes or clears this the moment its parent row goes.
   *
   * Enumerated rather than omitted, for the same reason `retain` is: a reference
   * nobody writes a leg for and a reference nobody thought about look identical
   * from the outside. An entry here says which constraint does it, so a reader
   * checking whether the cascade covers something finds an answer rather than a
   * silence. There is deliberately NO leg — see the module header.
   */
  | 'database'
  /**
   * The row is deliberately KEPT, pointing at content that no longer exists.
   *
   * Expressible as an action rather than left out of the manifest, because a
   * reference nobody removes and a reference nobody thought about look identical
   * from the outside — and the whole premise of this file is that they must not.
   * An entry here is a decision with a written reason and a name attached; an
   * absent entry is an oversight the coverage test will eventually find. Only the
   * first of those is safe to leave alone.
   */
  | 'retain';

/** Which set of ids the step's filter is built from. */
export type CascadeScope =
  /** The channel account's own `oxyUserId`. */
  | 'channel-account'
  /**
   * Every post being destroyed: the channel's own posts PLUS other people's
   * boosts of them, which are captured into the set BEFORE any row is deleted —
   * `posts.boost_of` is `ON DELETE CASCADE`, so the boosts and the only link
   * that could find them vanish inside the `DELETE` itself.
   */
  | 'channel-posts'
  /** The same posts, keyed by their ActivityPub ids/urls instead of `id`. */
  | 'channel-post-uris'
  /** The ids of the lanes the channel owns. */
  | 'channel-lanes';

export interface CascadeStep {
  /**
   * SQL table name, exactly as `getTableName(table)` answers — which is what the
   * coverage gate enumerates, so a typo here is a failing test rather than a
   * query nobody runs.
   */
  readonly table: string;
  /**
   * The drizzle column PROPERTY name (camelCase), exactly as
   * `Object.keys(getTableColumns(table))` answers.
   *
   * Deliberately the property name and not the SQL name: `column.name` on a
   * drizzle column IS the property name (casing is applied at runtime by
   * `drizzle()`, see `db/casing.ts`), so this is the spelling both the gate and
   * the service's binding table can check against without a conversion step
   * either of them could get wrong.
   */
  readonly column: string;
  readonly scope: CascadeScope;
  readonly action: CascadeAction;
  /** Why this disposition and not the other one. Read by humans, not by code. */
  readonly why: string;
}

/**
 * BOOSTS AND QUOTES — the one genuinely contested pair, and the database now
 * settles it.
 *
 * The question is what happens to OTHER people's posts that point at a post
 * being destroyed. The repo answered it in prose that predates channels
 * (`scripts/lib/adminDeletionPreflight.ts`), the schema then encoded that answer
 * as two different `ON DELETE` actions, and this manifest records which
 * constraint does what:
 *
 *  - A BOOST is deleted — `posts.boost_of` is `ON DELETE CASCADE`. Its body is
 *    deliberately empty and it renders entirely from the original, so once that
 *    is gone it is not degraded content, it is a placeholder card with nothing
 *    behind it. Deleting it removes an amplification, never an authored thought.
 *  - A QUOTE is KEPT with its pointer cleared — `posts.quote_of` is
 *    `ON DELETE SET NULL`. The quoter wrote their own words and those words are
 *    not the channel's to destroy; NULL is exactly "the quoted post is gone",
 *    and `attachNestedContext` drops the card.
 *
 * The Mongo cascade performed both of those itself and had to argue for
 * unsetting rather than leaving a dangling pointer. That argument is now the
 * schema's, made once, for every caller: `SET NULL` is not a policy this file
 * chooses per deletion.
 *
 * `parent_post_id` and `thread_id` get the same `SET NULL`, with one caveat: a
 * channel post cannot be replied to (the reply gate refuses a `channel` author
 * at five sites), so cross-author rows in that shape should not exist at all.
 * The constraint covers them anyway, because "should not exist" is an
 * assumption.
 */
export const CHANNEL_CASCADE: readonly CascadeStep[] = [
  // ---------------------------------------------------------------------------
  // PERFORMED BY POSTGRES. Deleting the channel's posts removes or clears every
  // row below inside the same statement.
  //
  // None of these has a leg, and adding one would be worse than useless: it
  // would re-run work the database has already done, and no check could ever
  // prove it ran — the rows are gone either way by the time anything looks. They
  // are enumerated so that a reader asking "does the cascade cover this" gets an
  // answer with a mechanism attached instead of silence.
  // ---------------------------------------------------------------------------
  {
    table: 'likes',
    column: 'postId',
    scope: 'channel-posts',
    action: 'database',
    why: 'A like is an edge to a post; with the post gone it has no subject. `ON DELETE CASCADE` on `posts.id`.',
  },
  {
    table: 'bookmarks',
    column: 'postId',
    scope: 'channel-posts',
    action: 'database',
    why:
      'A bookmark points at a post; a saved-list entry for a destroyed post renders as a hole. ' +
      '`ON DELETE CASCADE` on `posts.id`.',
  },
  {
    table: 'post_recent_repliers',
    column: 'postId',
    scope: 'channel-posts',
    action: 'database',
    why: 'A denormalized replier projection for a destroyed post. `ON DELETE CASCADE` on `posts.id`.',
  },
  {
    table: 'post_corrections',
    column: 'postId',
    scope: 'channel-posts',
    action: 'database',
    why:
      'The public correction trail of a channel post: the superseded bodies of a post that no longer ' +
      'exists. It is the channel\'s OWN writing, so destroying the channel destroys it — unlike an ' +
      'evidence row about the channel, which outlives it. `ON DELETE CASCADE` on `posts.id`.',
  },
  {
    table: 'post_corrections',
    column: 'correctedByOxyUserId',
    scope: 'channel-posts',
    action: 'database',
    why:
      'The human who made a correction — the same promise as `posts.written_by_oxy_user_id` and broken ' +
      'the same way if it survives. It is never served (the trail carries no author, precisely so a ' +
      'channel that did not opt into naming its writers cannot be made to), and nothing may reattribute ' +
      'a correction to its writer on the way out. The column carries no constraint of its own — it is an ' +
      'Oxy account id — so what removes it is the row it sits on: `ON DELETE CASCADE` on ' +
      '`post_corrections.post_id`, hanging off `posts.id`.',
  },
  {
    table: 'polls',
    column: 'postId',
    scope: 'channel-posts',
    action: 'database',
    why:
      'The poll the post owned, and with it every `poll_options` and `poll_votes` row, which cascade ' +
      'from `polls.id` in turn. `ON DELETE CASCADE` on `posts.id`.',
  },
  {
    table: 'articles',
    column: 'postId',
    scope: 'channel-posts',
    action: 'database',
    why: 'Long-form body owned by the post. `ON DELETE CASCADE` on `posts.id`.',
  },
  {
    table: 'engagement_outbox',
    column: 'payloadPostId',
    scope: 'channel-posts',
    action: 'database',
    why:
      'A queued engagement projection for a post that will not exist when it drains. Mongo held this ' +
      'inside a `Mixed` payload with no index, so the live delete route could only cancel the PENDING ' +
      'rows; here it is a real column with `ON DELETE CASCADE` on `posts.id` and the whole row goes.',
  },
  {
    table: 'post_authorships',
    column: 'postId',
    scope: 'channel-posts',
    action: 'database',
    why:
      'The owner (and any collaborator) entries of a destroyed post. `ON DELETE CASCADE` on `posts.id`. ' +
      'The channel as an authorship entry on somebody ELSE\'s surviving post is a different reference and ' +
      'has its own step.',
  },
  {
    table: 'post_mentions',
    column: 'postId',
    scope: 'channel-posts',
    action: 'database',
    why: 'Who a destroyed post mentioned. `ON DELETE CASCADE` on `posts.id`.',
  },
  {
    table: 'post_media',
    column: 'postId',
    scope: 'channel-posts',
    action: 'database',
    why:
      'Media attached to a destroyed post. `ON DELETE CASCADE` on `posts.id`. The BYTES are Oxy\'s and ' +
      'are enumerated in OWNED_BY_OXY — this removes only Mention\'s reference to them.',
  },
  {
    table: 'post_attachments',
    column: 'postId',
    scope: 'channel-posts',
    action: 'database',
    why: 'Non-media attachments of a destroyed post. `ON DELETE CASCADE` on `posts.id`.',
  },
  {
    table: 'post_sources',
    column: 'postId',
    scope: 'channel-posts',
    action: 'database',
    why: 'Cited sources of a destroyed post. `ON DELETE CASCADE` on `posts.id`.',
  },
  {
    table: 'post_content_variants',
    column: 'postId',
    scope: 'channel-posts',
    action: 'database',
    why:
      'The post\'s own text, in every language rendition — and with it `post_variant_media` and ' +
      '`post_variant_alt_texts`, which cascade from the variant. `ON DELETE CASCADE` on `posts.id`.',
  },
  {
    table: 'post_classification_topic_refs',
    column: 'postId',
    scope: 'channel-posts',
    action: 'database',
    why: 'Stage-B classification topics for a destroyed post. `ON DELETE CASCADE` on `posts.id`.',
  },
  {
    table: 'posts',
    column: 'boostOf',
    scope: 'channel-posts',
    action: 'database',
    why:
      'A boost has an intentionally empty body and renders entirely from its original, so a surviving ' +
      'one is a permanent "unavailable" placeholder — see the header note. `posts.boost_of` is a SELF ' +
      '`ON DELETE CASCADE`, so a boost of a boost goes too, transitively, in one statement. THE CATCH: ' +
      'those rows and their links are gone before any later step could run, so the boosts are CAPTURED ' +
      'into `channel-posts` first, while the links are still live.',
  },
  {
    table: 'posts',
    column: 'quoteOf',
    scope: 'channel-posts',
    action: 'database',
    why:
      'The quoter wrote their own words and keeps them; only the pointer goes. `ON DELETE SET NULL` — ' +
      'the schema makes this decision once for every caller, so there is deliberately no leg here. ' +
      'Anyone looking for one is looking for a second implementation of a rule the database enforces.',
  },
  {
    table: 'posts',
    column: 'parentPostId',
    scope: 'channel-posts',
    action: 'database',
    why:
      'A channel post cannot be replied to, so this set should be EMPTY; `ON DELETE SET NULL` covers it ' +
      'anyway because a cascade is the wrong place to hold an assumption. A reply that survives keeps ' +
      'its text and loses its "replying to" line.',
  },
  {
    table: 'posts',
    column: 'threadId',
    scope: 'channel-posts',
    action: 'database',
    why: 'Same shape as parentPostId: `ON DELETE SET NULL`, the post keeps its own content.',
  },
  {
    table: 'posts',
    column: 'laneId',
    scope: 'channel-lanes',
    action: 'database',
    why:
      'A lane belongs to one publisher and only that publisher\'s posts carry its id, so these rows are ' +
      'inside the deleted set already. `lanes` → `posts.lane_id` is `ON DELETE SET NULL`, so a ' +
      'mis-assigned row belonging to somebody else keeps its content and loses the lane.',
  },
  {
    table: 'lane_mutes',
    column: 'laneId',
    scope: 'channel-lanes',
    action: 'database',
    why:
      'A reader\'s mute of a lane that no longer exists. `lanes` → `lane_mutes.lane_id` is ' +
      '`ON DELETE CASCADE` — note the pair is deliberately asymmetric: the same parent SET NULLs a post ' +
      'and CASCADEs a mute, because a post is content and a mute is a preference about content.',
  },

  // ---------------------------------------------------------------------------
  // Post references NO foreign key can express, DELEGATED to
  // `services/PostDeletionCascade.ts`.
  //
  // That module already owns "what happens to a reference ON a post that is
  // gone" for the live delete route every user hits, and its
  // `POST_REFERENCE_DISPOSITION` is a `Record` over the preflight's probe list —
  // so a reference type added upstream breaks THAT file's build until somebody
  // decides what to do about it. A second implementation of the same decisions
  // destroys exactly that property, because one of the two will be the one
  // nobody remembers to update. `ChannelDeletionService` hands it the whole
  // doomed set and reports these under `delegated` rather than with a count of
  // its own. The manifest still names them, because the inventory has to stay
  // complete whoever performs the write.
  // ---------------------------------------------------------------------------
  {
    table: 'notifications',
    column: 'entityId',
    scope: 'channel-posts',
    action: 'delete-row',
    why:
      'A notification whose subject post is destroyed opens onto nothing when tapped. Polymorphic on ' +
      '`entity_type`, so no foreign key can carry it — DELEGATED, and the delegate matches both `post` ' +
      'and `reply`, which is the bug a `post`-only predicate hid.',
  },
  {
    table: 'content_labels',
    column: 'targetId',
    scope: 'channel-posts',
    action: 'delete-row',
    why:
      'A label on a destroyed post — rows filtered to `target_type = post`. DELEGATED, since a label on ' +
      'a post that is gone is the same reference whoever deleted the post; the channel-scoped rows in ' +
      'the SAME column are a different question and get their own step below.',
  },
  {
    table: 'postgates',
    column: 'postId',
    scope: 'channel-posts',
    action: 'delete-row',
    why:
      'A per-post quote/embed policy has no meaning once the post is gone. `post_id` is plain `text()` ' +
      'with no constraint — a gate is upserted on `post_uri` without proving the post exists — so this ' +
      'is a real leg rather than an FK. DELEGATED.',
  },
  {
    table: 'postgates',
    column: 'postUri',
    scope: 'channel-post-uris',
    action: 'delete-row',
    why: 'The same row reachable by AP uri as well as by id; both keys are swept so a uri-only row cannot survive. DELEGATED.',
  },
  {
    table: 'threadgates',
    column: 'postId',
    scope: 'channel-posts',
    action: 'delete-row',
    why: 'A per-thread reply policy owned by the root post; unconstrained for the same reason as postgates. DELEGATED.',
  },
  {
    table: 'threadgates',
    column: 'postUri',
    scope: 'channel-post-uris',
    action: 'delete-row',
    why: 'The same row reachable by AP uri instead of id; both keys are swept. DELEGATED.',
  },
  {
    table: 'feed_interactions',
    column: 'postUri',
    scope: 'channel-post-uris',
    action: 'delete-row',
    why:
      'Ranking telemetry keyed by post URI rather than by `posts.id`, so no foreign key reaches it. ' +
      'Left behind it would train affinity on removed content. DELEGATED.',
  },
  {
    table: 'reports',
    column: 'reportedId',
    scope: 'channel-posts',
    action: 'retain',
    why:
      'A report about a destroyed post is KEPT, and deleting it would break something rather than merely ' +
      'lose an audit trail. An inbound CrowdSource decision is matched to local rows by ' +
      '`reports.crowd_source_case_id`, and `ModerationDecisionWorker` throws a RETRYABLE ' +
      '`ModerationDecisionDeferredError` when a case resolves to no report — so a decision arriving after ' +
      'the reported post was destroyed would back off and retry until it expired. That reason does not ' +
      'depend on WHO deleted the post, so it cannot have two answers depending on the cause: this follows ' +
      'the live delete path (`POST_REFERENCE_DISPOSITION` in `PostDeletionCascade`), which retains it for ' +
      'exactly this reason. `purgeBlockedDomainContent` DOES delete these, deliberately and differently — ' +
      'it removes a blocked instance\'s content wholesale and its cascade owns that call; the divergence ' +
      'is noted here so a reader does not take this for an oversight. The other side is already designed ' +
      'for a vanished subject: `ModerationDeliveryWorker` closes the report as undeliverable rather than ' +
      'retrying, so the row is stranded by being removed, never by being kept.',
  },
  {
    table: 'moderation_outbox',
    column: 'payloadReportId',
    scope: 'channel-posts',
    action: 'retain',
    why:
      'The delivery job for a report, kept because its report is now kept: with the report surviving there ' +
      'is nothing orphaned, and deleting the job would strand a report at `queued` that nothing will ever ' +
      'deliver. It could not be deleted independently in any case — `payload_report_id` is ' +
      '`ON DELETE CASCADE` on `reports.id`, so the job\'s lifetime is the report\'s by construction, which ' +
      'is the schema stating this same decision. The one report this cascade still removes is one the ' +
      'channel FILED (`reports.reporter`, which cannot exist — a channel can never be acted as), and even ' +
      'that leaves no stuck job: the cascade takes the job with it, and `deliverReportOutboxEvent` ' +
      'completes an event whose report is gone instead of retrying it.',
  },

  // ---------------------------------------------------------------------------
  // Post references executed HERE, because the preflight has no probe for them
  // and therefore the delegate has no leg for them either.
  // ---------------------------------------------------------------------------
  {
    table: 'postgates',
    column: 'detachedQuoteUris',
    scope: 'channel-post-uris',
    action: 'pull-from-array',
    why:
      'A channel post that quoted somebody and was detached is listed by uri inside THEIR postgate. The ' +
      'row is theirs and stays; only the entry naming a destroyed post goes. NOT delegated — the delegate ' +
      'deletes the postgate rows that BELONG to a doomed post, which is a different question from an ' +
      'entry naming one inside a stranger\'s row.',
  },
  {
    table: 'moderation_enforcements',
    column: 'subjectId',
    scope: 'channel-posts',
    action: 'delete-row',
    why:
      'An enforcement record whose subject post is gone. Named `subject_id`, so a scanner keyed on ' +
      '"post_id" misses it — which is exactly why the coverage test keys on id SHAPE and not on a name ' +
      'list. Executed HERE: it is not one of the preflight\'s probes, so the delegate has no leg for it.',
  },
  {
    table: 'repair_fetch_failures',
    column: 'postId',
    scope: 'channel-posts',
    action: 'delete-row',
    why:
      'An admin repair-log row naming a post that no longer exists. Absent from the preflight probes, and ' +
      'therefore from `PostDeletionCascade` too — so this one is executed HERE. It is also the one step ' +
      'that runs AGAINST the schema\'s own default: `deferredForeignKeys.ts` leaves this column ' +
      'unconstrained precisely because an evidence row must outlive its subject, so a USER deleting one ' +
      'post never touches it. An operator destroying a channel wholesale is the other case — the same ' +
      'distinction `purgeBlockedDomainContent` makes — and the set should be empty regardless: the rows ' +
      '`reingestEmptyFederatedPosts` writes are about FEDERATED posts, and a channel is local.',
  },

  // ---------------------------------------------------------------------------
  // The channel's own posts. Deleted AFTER everything above, so that a crash
  // never destroys the ids the steps above are enumerated from.
  // ---------------------------------------------------------------------------
  {
    table: 'posts',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'The channel\'s posts. The whole point: with the channel gone their only public author is gone.',
  },
  {
    table: 'posts',
    column: 'writtenByOxyUserId',
    scope: 'channel-posts',
    action: 'delete-row',
    why:
      'Carried by the same rows being deleted. It is NEVER used to reattribute a post to its writer: for ' +
      'a channel that did not opt into naming its writers, that would retroactively publish who wrote ' +
      'what — the one promise a channel makes, broken at the moment it is no longer there to answer for ' +
      'it. The column is a plain `text()` Oxy account id with no constraint, so nothing in the database ' +
      'would stop a reattributing UPDATE; this rule is held up by the cascade and by ' +
      '`channelCascadeCoverage.test.ts`, not by the schema.',
  },
  {
    table: 'post_authorships',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-entry',
    why:
      'The channel named as an author on somebody ELSE\'s surviving post. Its own posts\' authorship rows ' +
      'cascade with the post (see the `post_authorships.post_id` step); this is the other direction, and ' +
      'the post belongs to a third party so only the entry goes. A channel is refused as a collaborator ' +
      'today, so this should be empty — swept so "should be" is enforced rather than assumed.',
  },
  {
    table: 'post_mentions',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-entry',
    why:
      'Other people\'s posts that @-mention the channel. Mongo held this as an array on the post and the ' +
      'cascade `$pull`ed the id; the array is a junction table now and the entry is a row, but the policy ' +
      'is unchanged — the post is theirs and stays, and the mention would otherwise render a link to an ' +
      'account that no longer resolves.',
  },

  // ---------------------------------------------------------------------------
  // Lanes.
  // ---------------------------------------------------------------------------
  {
    table: 'lanes',
    column: 'ownerId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'Lanes the channel owns. Absent from the preflight probes for posts entirely. Deleting these is ' +
      'what fires the two lane constraints above, so it runs after the mutes have been swept by account.',
  },
  {
    table: 'lane_mutes',
    column: 'laneOwnerOxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'The same mutes reachable by PUBLISHER rather than by lane. Swept so a mute cannot outlive its lane ' +
      'by either key — the denormalized owner column carries no constraint, so the FK on `lane_id` is not ' +
      'a substitute for it.',
  },
  {
    table: 'lane_mutes',
    column: 'viewerOxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'A channel can never be acted as, so it cannot be a viewer; swept defensively like the other actor-side rows.',
  },

  // ---------------------------------------------------------------------------
  // Federation. Drained FIRST, before anything is told the channel is gone.
  // ---------------------------------------------------------------------------
  {
    table: 'federation_delivery_queue',
    column: 'senderOxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'Undelivered outbound activities from the channel. They must go BEFORE the actor delete is ' +
      'broadcast, or a queued Create races the Delete and republishes a post on the receiving instance.',
  },
  {
    table: 'federated_follows',
    column: 'localUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Remote accounts following the channel. Read BEFORE deletion to address the Delete(actor) broadcast.',
  },
  {
    table: 'actor_key_pairs',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'The channel\'s ActivityPub signing key. Deleted LAST among account rows: outbound deletes are signed with it.',
  },
  {
    table: 'federated_actors',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'A channel is a LOCAL account, so no anchor row should ever name it — these are written only for ' +
      'remote actors. Swept so that a mislabelled row cannot survive as the last thing pointing at the ' +
      'channel; `federated_actor_fields` cascades from the row.',
  },

  // ---------------------------------------------------------------------------
  // Rows keyed on the channel ACCOUNT. Every one of these is a plain `text()`
  // column holding a foreign service's primary key, so every one of them needs
  // an explicit leg — this block is where the cascade's real work is.
  // ---------------------------------------------------------------------------
  {
    table: 'notifications',
    column: 'entityId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'The SAME column holds an oxyUserId when `entity_type` is "profile" (a follow or a poke). A sweep ' +
      'that only ever read it as a post id leaves those rows pointing at a deleted channel.',
  },
  {
    table: 'notifications',
    column: 'recipientId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'Notifications addressed to the channel. It has no session to read them — `GET /notifications` ' +
      'expands a reader\'s operated-channel ids at request time — but the rows are real and must go.',
  },
  {
    table: 'notifications',
    column: 'actorId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Notifications naming the channel as the actor; the "X posted" row would name an account that will not resolve.',
  },
  {
    table: 'content_labels',
    column: 'targetId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'The same polymorphic column holds an oxyUserId when `target_type` is "user": a label applied TO the ' +
      'channel. Nothing else sweeps it — the post-scoped delegate reads the column only as a post id — so ' +
      'a label ON a deleted channel would survive as the last row pointing at it.',
  },
  {
    table: 'content_labels',
    column: 'createdBy',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Labels the channel applied.',
  },
  {
    table: 'reports',
    column: 'reportedId',
    scope: 'channel-account',
    action: 'retain',
    why:
      'A report ABOUT the channel, kept for the identical reason a report about its post is: the column is ' +
      'polymorphic on `reported_type`, and an inbound CrowdSource decision that resolves to no local ' +
      'report leaves `ModerationDecisionWorker` retrying until it expires. A moderation record about an ' +
      'account is also the last thing an operator wants erased by the account being taken down — the ' +
      'record of why is the point. Named separately from the post-scoped step because the two are ' +
      'different references that happen to share a column, exactly like `notifications.entity_id`.',
  },
  {
    table: 'reports',
    column: 'reporter',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'Reports filed BY the channel; defensive, it cannot act. `moderation_outbox` rows for them cascade ' +
      'from `reports.id`, so the delivery job cannot be stranded.',
  },
  {
    table: 'user_settings',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'The channel\'s settings row, which carries the writer-disclosure decision. Named in prose rather ' +
      'than by its flag: `channelWriterDisclosure.ts` is that flag\'s one reader, and a gate enforces it. ' +
      '`user_settings_label_actions` cascades from the row.',
  },
  {
    table: 'user_settings',
    column: 'privacyRestrictedUsers',
    scope: 'channel-account',
    action: 'pull-from-array',
    why:
      'Another person\'s privacy settings naming the channel as restricted. Their row is theirs and stays; ' +
      'only the entry goes. It carries no id-shaped suffix, so the scanner cannot flag it — the manifest ' +
      'names it anyway, which is what keeps a column no gate can find from being the one nobody swept.',
  },
  {
    table: 'author_follower_snapshots',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Denormalized follower counts used by feed ranking.',
  },
  {
    table: 'mention_signed_records',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'The channel\'s MTN hash chain. A channel post does emit a signed record, under the channel\'s own identity.',
  },
  {
    table: 'mention_repo_heads',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'The head of that chain; orphaned the moment the records go.',
  },
  {
    table: 'mention_user_nodes',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Self-hosted node registration for the channel.',
  },
  {
    table: 'mention_node_ingest_witnesses',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Ingest witnesses for that node.',
  },
  {
    table: 'engagement_outbox',
    column: 'payloadActorOxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Queued projections whose actor is the channel.',
  },
  {
    table: 'engagement_outbox',
    column: 'payloadPostOwnerOxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Queued projections whose post owner is the channel.',
  },
  {
    table: 'user_behaviors',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'A viewer-behaviour row for the channel. It cannot be acted as, so this should be empty; swept ' +
      'defensively. Its `user_behavior_authors`, `user_behavior_topics` and `user_behavior_regions` ' +
      'children cascade from the row.',
  },
  {
    table: 'user_behavior_authors',
    column: 'authorId',
    scope: 'channel-account',
    action: 'delete-entry',
    why:
      'The channel inside ANOTHER viewer\'s affinity entries. Mongo held this as `preferredAuthors[]`, an ' +
      'array of subdocuments keyed on `authorId`, and the cascade `$pull`ed the matching element; the ' +
      'array is a child table now, so the element is a row. The viewer\'s own behaviour row is theirs and ' +
      'stays.',
  },
  {
    table: 'user_behaviors',
    column: 'hiddenAuthors',
    scope: 'channel-account',
    action: 'pull-from-array',
    why: 'Another viewer\'s hidden-author list; scrubbed, never deleted. Still a `text[]` column, not a child table.',
  },
  {
    table: 'user_behaviors',
    column: 'mutedAuthors',
    scope: 'channel-account',
    action: 'pull-from-array',
    why: 'Another viewer\'s muted-author list.',
  },
  {
    table: 'user_behaviors',
    column: 'blockedAuthors',
    scope: 'channel-account',
    action: 'pull-from-array',
    why: 'Another viewer\'s blocked-author list.',
  },
  {
    table: 'user_feed_preferences',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'Feed preferences for the channel; defensive, same reason as user_behaviors. `user_saved_feeds` ' +
      'cascades from the row, which is what reaches the saved descriptors listed in ' +
      'EMBEDDED_CHANNEL_REFERENCES.',
  },
  {
    table: 'mutes',
    column: 'mutedId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Somebody\'s mute OF the channel. The row exists only to name that pair, so it dies with the channel.',
  },
  {
    table: 'mutes',
    column: 'userId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Mutes BY the channel; defensive, it cannot act.',
  },
  {
    table: 'mute_words',
    column: 'userId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Muted words owned by the channel; defensive.',
  },
  {
    table: 'likes',
    column: 'userId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'Likes BY the channel on other people\'s posts. Their `stats_likes_count` is repaired in the same ' +
      'run — a surviving post must not keep a count that includes a deleted record.',
  },
  {
    table: 'bookmarks',
    column: 'userId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Bookmarks owned by the channel.',
  },
  {
    table: 'post_subscriptions',
    column: 'subscriberId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Subscriptions the channel holds.',
  },
  {
    table: 'post_subscriptions',
    column: 'authorId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Other people\'s subscriptions to the channel\'s output; the author they name is gone.',
  },
  {
    table: 'post_recent_repliers',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-entry',
    why:
      'The channel inside another post\'s replier projection; that post belongs to someone else. Mongo ' +
      'held the repliers as an array of subdocuments on the post and `$pull`ed one; the projection is a ' +
      'child table now, so the element is a row.',
  },
  {
    table: 'entity_follows',
    column: 'userId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Hashtag/list follows owned by the channel; defensive.',
  },
  {
    table: 'feed_interactions',
    column: 'userId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Ranking telemetry attributed to the channel as a viewer; defensive.',
  },
  {
    table: 'feed_likes',
    column: 'userId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Custom-feed subscriptions held by the channel; defensive.',
  },
  {
    table: 'feed_reviews',
    column: 'reviewerId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Feed reviews written by the channel; defensive.',
  },
  {
    table: 'feed_generators',
    column: 'createdBy',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Feed generators the channel registered.',
  },
  {
    table: 'labelers',
    column: 'creatorId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'Labeler services the channel created. Their `content_labels` and `labeler_label_definitions` ' +
      'cascade from `labelers.id`, so the labels a deleted service emitted go with it.',
  },
  {
    table: 'pokes',
    column: 'pokerId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Pokes sent by the channel; defensive.',
  },
  {
    table: 'pokes',
    column: 'pokedId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Pokes aimed at the channel.',
  },
  {
    table: 'push_tokens',
    column: 'userId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'A channel has no device and no session, so this must be empty; swept so "must be" is enforced, not assumed.',
  },
  {
    table: 'polls',
    column: 'createdBy',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'Polls authored by the channel outside its own posts — `polls.post_id` is NULLABLE because the ' +
      'composer creates a poll before its post exists, so an abandoned draft poll has no post to cascade ' +
      'from and is reachable only by its author.',
  },
  {
    table: 'poll_votes',
    column: 'userId',
    scope: 'channel-account',
    action: 'delete-entry',
    why:
      'The channel\'s vote inside somebody else\'s poll. Mongo held votes as a `[String]` array inside ' +
      'each embedded option; here they are rows, so the entry is a row and the poll survives one fewer ' +
      'vote. No counter to repair — the tally is a `GROUP BY`, never a denormalized column.',
  },
  {
    table: 'articles',
    column: 'createdBy',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Articles authored by the channel.',
  },
  {
    table: 'postgates',
    column: 'createdBy',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Quote policies the channel set.',
  },
  {
    table: 'threadgates',
    column: 'createdBy',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Reply policies the channel set; `threadgate_allow_rules` cascades from the row.',
  },
  {
    table: 'account_lists',
    column: 'ownerOxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'Lists the channel owns; an ownerless list is unreachable and unmanageable. Its members and any ' +
      '`custom_feed_source_lists` rows drawing on it cascade from `account_lists.id`.',
  },
  {
    table: 'account_list_members',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-entry',
    why: 'The channel as a MEMBER of somebody else\'s list; the list is theirs and survives one fewer member.',
  },
  {
    table: 'custom_feeds',
    column: 'ownerOxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'Custom feeds the channel owns. Their modules, members, source lists, topics, likes and reviews all ' +
      'cascade from `custom_feeds.id`.',
  },
  {
    table: 'custom_feed_members',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-entry',
    why: 'The channel as a member of somebody else\'s feed definition.',
  },
  {
    table: 'starter_packs',
    column: 'ownerOxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Starter packs the channel owns; members and use records cascade from `starter_packs.id`.',
  },
  {
    table: 'starter_pack_members',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-entry',
    why: 'The channel as a member of somebody else\'s pack.',
  },
  {
    table: 'starter_pack_uses',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-entry',
    why:
      'The channel recorded as having used a pack. Mongo held this as `usedByOxyUserIds` on the pack, so ' +
      'the pack\'s `use_count` was the array length; the count is now its own column and is repaired ' +
      'nowhere — deliberately, since it is a lifetime tally rather than a live membership.',
  },
  {
    table: 'endorsement_outbox',
    column: 'pendingRemoveOwnerId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'A queued endorsement retraction naming the channel as owner.',
  },
  {
    table: 'endorsement_outbox',
    column: 'pendingRemoveMemberIds',
    scope: 'channel-account',
    action: 'pull-from-array',
    why: 'The channel inside another scope\'s pending-removal list; the row belongs to that scope.',
  },
  {
    table: 'trending',
    column: 'actorIds',
    scope: 'channel-account',
    action: 'pull-from-array',
    why:
      'A trend row naming the channel among its actors. The trend belongs to the term, not the account, so ' +
      'the row survives with one fewer actor. Still a `text[]` column rather than a child table.',
  },
  {
    table: 'mcp_connections',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'A Claude connector bound to the channel. `isActAsEligibleKind` refuses a channel as a session ' +
      'subject and the OAuth consent screen is authorized against a person, so this must be empty — swept ' +
      'because a row here would be a live credential naming a deleted account. Absent from the Mongo-era ' +
      'manifest entirely, which is what re-pointing the gate at the real schema surfaced.',
  },
  {
    table: 'mcp_connections',
    column: 'activeOxyUserId',
    scope: 'channel-account',
    action: 'unset-field',
    why:
      'A BUNDLE\'s active account, stored on somebody else\'s primary connection row. Deleting their ' +
      'connection because its active pointer names the channel would revoke a person\'s connector over an ' +
      'account they merely switched to, so the pointer is cleared instead — `mcpBundleService` already ' +
      'falls back to the connection\'s own owner when it is null. The one place this cascade NULLs a ' +
      'column itself rather than letting a constraint do it, because there is no constraint: an Oxy ' +
      'account id cannot carry one.',
  },
  {
    table: 'mcp_auth_codes',
    column: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'A short-lived OAuth code minted for the channel; same structural impossibility as the connection ' +
      'above, swept for the same reason. A code outliving its account is a credential nobody can revoke.',
  },
];

/**
 * Id-shaped columns that do NOT reference an Oxy account or a Mention post, with
 * what each one actually names.
 *
 * This list exists so the coverage test can be exhaustive without being useless:
 * the scanner flags every column whose PROPERTY NAME looks like an id, which is
 * the only way a NEW reference cannot slip past it, and that necessarily catches
 * topic ids, file ids and run ids too. Each is dismissed once, here, in writing.
 */
export const NOT_A_CHANNEL_REFERENCE: ReadonlyMap<string, string> = new Map([
  ['account_list_members.listId', 'the AccountList the membership row belongs to; it cascades from the list'],
  ['actor_key_pairs.keyId', 'the key pair\'s own AP key identifier, not an account'],
  ['blocked_domain_purge_runs.runId', 'an admin purge run, not an account'],
  ['blocked_domain_purges.runId', 'an admin purge run'],
  ['blocklist_proposal_observations.proposalId', 'the proposal an observation belongs to'],
  ['blocklist_proposal_run_sources.runRowId', 'the blocklist proposal run row a source belongs to'],
  ['blocklist_proposal_runs.runId', 'a blocklist proposal run'],
  ['content_labels.labelerId', 'the Labeler service that emitted the label'],
  ['custom_feed_definition_modules.feedId', 'the CustomFeed the module belongs to; it cascades from the feed'],
  ['custom_feed_members.feedId', 'the CustomFeed the membership row belongs to'],
  ['custom_feed_source_lists.feedId', 'the CustomFeed drawing on a list'],
  ['custom_feed_source_lists.listId', 'the AccountList a feed draws from'],
  ['custom_feed_topics.feedId', 'the CustomFeed a topic belongs to'],
  ['custom_feed_topics.topicId', 'a topic id'],
  ['endorsement_outbox.sourceId', 'the starter-pack or list id the scope belongs to'],
  ['engagement_outbox.payloadFederationActivityId', 'an ActivityPub activity id'],
  ['engagement_outbox.payloadRelationshipId', 'an Oxy relationship edge id, owned by Oxy'],
  ['entity_follows.entityId', 'a hashtag or list id; entityType is never "user"'],
  ['federated_actor_fields.actorId', 'the FederatedActor row a profile field belongs to; it cascades from the actor'],
  ['federated_actors.publicKeyId', 'a remote actor\'s AP key id'],
  ['federated_follows.activityId', 'the AP activity that created the follow'],
  [
    'federated_follows.remoteActorUri',
    'the REMOTE side of a follow edge. A channel is a local account and can never appear here; the channel\'s ' +
      'own rows are deleted by `local_user_id`',
  ],
  ['federated_media_cache.oxyFileId', 'an Oxy S3 file id; the cache is keyed on a remote URL, never on an account'],
  ['federated_media_cache.posterFileId', 'an Oxy S3 file id for an extracted video poster'],
  ['feed_likes.feedId', 'the CustomFeed being subscribed to'],
  ['feed_reviews.feedId', 'the CustomFeed being reviewed'],
  ['gifs.klipyId', 'an upstream GIF provider id'],
  ['gifs.mp4FileId', 'an Oxy file id'],
  ['gifs.previewFileId', 'an Oxy file id'],
  ['labeler_label_definitions.labelerId', 'the Labeler service a definition belongs to; it cascades from the labeler'],
  ['mcp_auth_codes.clientId', 'an OAuth client id, which may name a statically configured client with no row'],
  ['mcp_auth_codes.redirectUri', 'the OAuth redirect the code was issued for — a client URL, never a post'],
  ['mcp_connections.bundleId', 'a grouping token; the bundle IS the set of rows sharing it, so there is no parent row'],
  ['mcp_connections.clientId', 'an OAuth client id'],
  ['mcp_registered_clients.clientId', 'the dynamically registered client\'s own id'],
  ['mcp_registered_clients.redirectUris', 'the OAuth redirects a client registered — client URLs, never posts'],
  ['mention_node_ingest_witnesses.recordId', 'a signed-record id within a chain'],
  ['mention_repo_heads.headRecordId', 'the signed record at the head of a chain'],
  ['mention_signed_records.recordId', 'the record\'s own id'],
  ['moderation_enforcements.caseId', 'a CrowdSource case id; CrowdSource owns cases'],
  ['moderation_enforcements.decisionId', 'a CrowdSource decision id'],
  ['moderation_events.caseId', 'a CrowdSource case id'],
  ['moderation_outbox.payloadCaseId', 'a CrowdSource case id'],
  ['moderation_outbox.payloadEventId', 'a CrowdSource event id'],
  ['poll_options.pollId', 'the Poll an option belongs to; it cascades from the poll'],
  ['poll_votes.optionId', 'the option a vote was cast for'],
  ['poll_votes.pollId', 'denormalized from the option so one-vote-per-poll can be a UNIQUE constraint'],
  ['post_attachments.attachmentId', 'an Oxy file id or an external attachment id, never an account'],
  ['post_classification_topic_refs.topicId', 'a topic id'],
  ['post_media.mediaId', 'an Oxy file id, or a remote URL for federated media the cache never rewrote'],
  ['post_variant_alt_texts.mediaId', 'an Oxy file id the localized alt text describes'],
  ['post_variant_alt_texts.variantId', 'the language rendition the alt text belongs to'],
  ['post_variant_media.mediaId', 'an Oxy file id'],
  ['post_variant_media.variantId', 'the language rendition the media belongs to'],
  ['posts.contentArticleId', 'the Article row the post owns, removed by `articles.post_id`'],
  ['posts.contentEventId', 'an event attachment id'],
  ['posts.contentPodcastSyraId', 'a Syra podcast id, owned by Syra'],
  ['posts.contentPollId', 'the Poll row the post owns, removed by `polls.post_id`'],
  ['posts.contentRoomId', 'a Syra live-room id, owned by Syra'],
  ['posts.federationActivityId', 'the AP activity id of a federated post; a channel post is local'],
  ['posts.federationActorUri', 'the remote actor uri of a federated post; never set for a local channel'],
  ['push_tokens.deviceId', 'a device identifier'],
  ['reports.crowdSourceCaseId', 'a CrowdSource case id'],
  ['reports.crowdSourceReportId', 'a CrowdSource report id'],
  ['reports.decisionId', 'a CrowdSource decision id'],
  ['starter_pack_members.packId', 'the StarterPack the membership row belongs to'],
  ['starter_pack_uses.packId', 'the StarterPack that was used'],
  ['starter_packs.sourceUri', 'the remote pack URL an imported pack was mirrored from, not a post uri'],
  ['threadgate_allow_rules.listId', 'the AccountList a `listOnly` rule admits'],
  ['threadgate_allow_rules.threadgateId', 'the Threadgate a rule belongs to; it cascades from the gate'],
  ['topic_stats.topicId', 'a topic id'],
  ['trend_graphs.edges', 'term-to-term co-occurrence edges, not accounts'],
  ['trending.topicId', 'a topic id'],
  ['user_behavior_authors.behaviorId', 'the UserBehavior row an affinity entry belongs to; it cascades from the row'],
  ['user_behavior_regions.behaviorId', 'the UserBehavior row a region entry belongs to'],
  ['user_behavior_topics.behaviorId', 'the UserBehavior row a topic entry belongs to'],
  ['user_behavior_topics.topicId', 'a topic id'],
  ['user_saved_feeds.preferenceId', 'the UserFeedPreference row a saved feed belongs to; it cascades from the row'],
  ['user_settings.profileMediaSyraPodcastId', 'a Syra podcast id'],
  ['user_settings.profileMediaSyraTrackId', 'a Syra track id'],
  ['user_settings_label_actions.labelerId', 'a subscribed Labeler service'],
  ['user_settings_label_actions.settingsId', 'the UserSettings row a label action belongs to; it cascades from the row'],
]);

/**
 * References that live INSIDE a string or a `jsonb` blob, where no column names
 * them.
 *
 * This list exists because the coverage test is structurally blind to them: it
 * enumerates declared COLUMNS, and `author|<oxyUserId>` inside a feed descriptor,
 * or an actor uri inside an ActivityStreams document, is not a column. Saying so
 * out loud is the point — a gate whose blind spot is undocumented gets mistaken
 * for a complete one, and the next person to add an embedded reference has no way
 * to know this file wanted to hear about it.
 *
 * RE-AUDITED FOR POSTGRES, and the blind spot MOVED. Mongo's `Mixed` payloads on
 * `EngagementOutbox` and `ModerationOutbox` are first-class columns now
 * (`payload_post_id`, `payload_actor_oxy_user_id`, `payload_report_id`, …), so
 * the gate sees them and they are ordinary cascade steps — three former entries
 * deleted, not forgotten. `jsonb` survives in exactly four places
 * (CONVENTIONS.md names them) and only two can hold a channel reference.
 *
 * Each entry names how the cascade reaches it, or states that it deliberately
 * does not and why that is harmless.
 */
export const EMBEDDED_CHANNEL_REFERENCES: ReadonlyMap<string, string> = new Map([
  [
    'mention_signed_records.rkey / .subject_did / .envelope',
    'A post record\'s `rkey` IS the `posts.id`, and the DID embeds the oxyUserId; the envelope is a signed ' +
      'document that must round-trip, so nothing may rewrite it. REACHED: the whole chain is deleted by ' +
      '`oxy_user_id`, so no per-column sweep is needed.',
  ],
  [
    'mention_repo_heads.subject_did',
    'Embeds the channel\'s oxyUserId. REACHED: the row is deleted by `oxy_user_id`.',
  ],
  [
    'federation_delivery_queue.activity_json.actor / .object',
    'The sender actor uri and the post uri inside a queued ActivityStreams document — one of the four ' +
      'genuinely shape-less `jsonb` columns. REACHED twice, from both ends: every row the CHANNEL queued is ' +
      'deleted by `sender_oxy_user_id` before the actor Delete is broadcast, and a row anybody else queued ' +
      'that NAMES a doomed post is cancelled by the delegate (`PostDeletionCascade`), which owns that ' +
      'disposition — pending rows only, since a delivered row is a log entry.',
  ],
  [
    'custom_feed_definition_modules.params.authorIds',
    'A legacy account-source feed can pin the channel by id inside the module `params` blob, which is ' +
      'deliberately shape-less because the MODULE defines it, not the engine. NOT REACHED — projecting it ' +
      'would mean the engine asserting a shape it does not own. Harmless: the source resolves the id ' +
      'through the ordinary author path, which returns nothing once the account is archived, so the feed ' +
      'loses a contributor rather than breaking.',
  ],
  [
    'likes.source / feed_interactions.feed_descriptor / user_saved_feeds.descriptor',
    'Ranking telemetry and saved feeds embed `author|<oxyUserId>` or `lane|<laneId>` inside an opaque ' +
      'descriptor string. NOT REACHED for third-party rows: these are provenance labels, not pointers — ' +
      'nothing dereferences them to render, and a descriptor naming a gone author simply ranks nothing. ' +
      'The channel\'s OWN rows are deleted outright, `user_saved_feeds` by cascade from the preference row.',
  ],
  [
    'moderation_events.payload / moderation_outbox.payload_decision',
    'A CrowdSource decision names its subject inside a payload §10.11 keeps deliberately LOOSE — ' +
      'projecting it would silently drop whatever a newer CrowdSource added. NOT REACHED, and that agrees ' +
      'with the decision one level up: the `reports` rows these resolve against are RETAINED, so a payload ' +
      'naming a destroyed post is pointing at a report that is still there.',
  ],
  [
    'user_settings.privacy_restricted_users',
    'Another person\'s settings naming the channel as restricted. SCRUBBED by an explicit ' +
      '`pull-from-array` step, because their settings row is theirs and only the entry goes. Listed here ' +
      'for continuity with the Mongo cascade, where it WAS a blind spot (a nested path under a `privacy` ' +
      'subdocument); on Postgres it is a first-class `text[]` column the manifest names directly, so it is ' +
      'no longer invisible — only un-flaggable, since `privacyRestrictedUsers` carries no id-shaped suffix.',
  ],
]);

/**
 * Real references to a deleted channel that Mention CANNOT remove, because the
 * row lives on the other side of the Oxy boundary.
 *
 * Enumerated rather than silently omitted. An orphan in Oxy is still an orphan,
 * and the operator closing one needs to know it exists — the blocked-domain
 * purge is the precedent: Mention purges its own half and calls oxy-api's
 * `POST /federation/domain-purge` for Oxy's, because neither side can do the
 * other's work.
 */
export const OWNED_BY_OXY: ReadonlyMap<string, string> = new Map([
  [
    'Account graph membership (`account_members`)',
    'The rows naming who may publish as the channel. Only Oxy can remove them, and only Oxy can enforce ' +
      'the "a channel cannot have zero members" invariant — Mention never sees a member join or leave.',
  ],
  [
    'The channel account itself (`users`, kind: channel)',
    'Deleted via the SDK\'s `archiveAccount` (a soft archive, not a row removal). Mention has no way to hard-delete it.',
  ],
  [
    'Follow edges to the channel (the Oxy graph)',
    'Following a channel is an ordinary Oxy follow. Mention reads them and never owns them; archiving the ' +
      'account is what stops them resolving.',
  ],
  [
    'Media uploaded by the channel (Oxy S3 assets)',
    'Post media are bare Oxy file ids. Mention deletes the posts that referenced them; the bytes are Oxy\'s ' +
      'to collect and there is no Mention-side call that removes them.',
  ],
  [
    'Blocks involving the channel',
    'Oxy owns block rows and deletes them with the identity — the actor purge makes the same exemption for ' +
      'the same reason, and duplicating it here would be a second authority for one fact.',
  ],
]);
