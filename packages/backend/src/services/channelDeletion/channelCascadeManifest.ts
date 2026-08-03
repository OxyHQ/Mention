/**
 * The complete, enumerated inventory of everything in Mention's own database
 * that points at a channel account or at a post a channel authored.
 *
 * WHY THIS IS A DATA STRUCTURE AND NOT A FUNCTION
 *
 * A hand-written cascade goes stale the day somebody adds a model, and it fails
 * SILENTLY: the new collection keeps rows pointing at a channel that no longer
 * exists, nothing throws, and nobody finds out for months. So the cascade is
 * expressed as data that a test can compare against the real model tree —
 * `src/__tests__/services/channelCascadeCoverage.test.ts` walks
 * `src/models/*.ts`, extracts every id-shaped field, and fails when one is not
 * classified here. A new model with a `postId` breaks that test on the commit
 * that adds it, which is the only mechanism that keeps this honest.
 *
 * Every id-shaped field in every model is in EXACTLY ONE of three places:
 *   - {@link CHANNEL_CASCADE} — it references a channel or a channel's post, and
 *     this is what the cascade does about it.
 *   - {@link NOT_A_CHANNEL_REFERENCE} — the id names something that is neither an
 *     Oxy account nor a Mention post (a topic, a feed, a run, a file, a
 *     CrowdSource case), with the reason.
 *   - {@link OWNED_BY_OXY} — it is a real reference that Mention CANNOT delete,
 *     because the row on the other side of it belongs to Oxy. Enumerated rather
 *     than omitted: an orphan across the boundary is still an orphan, and the
 *     only way an operator can close it is by knowing it is there.
 *
 * The cascade EXECUTES this list (see `ChannelDeletionService`), rather than
 * describing something implemented separately. That is deliberate — a manifest
 * that merely documents a hand-written cascade is a second thing to keep in
 * sync, and the two would drift in exactly the direction nobody notices.
 */

/** What the cascade does to a row that carries the reference. */
export type CascadeAction =
  /** The row exists only because of the channel or its post; it dies with it. */
  | 'delete-row'
  /**
   * The row belongs to SOMEBODY ELSE and carries its own content. The pointer is
   * removed and the row is kept — deleting it would destroy a third party's work
   * in order to remove the channel's.
   */
  | 'pull-from-array'
  | 'unset-field'
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
   * boosts of them, which are resolved into the set before any row is deleted.
   */
  | 'channel-posts'
  /** The same posts, keyed by their ActivityPub ids/urls instead of `_id`. */
  | 'channel-post-uris'
  /** The `_id`s of the lanes the channel owns. */
  | 'channel-lanes';

export interface CascadeStep {
  /** Model FILE basename under `src/models`, which is what the scanner sees. */
  readonly model: string;
  /** The schema field carrying the reference. */
  readonly field: string;
  readonly scope: CascadeScope;
  readonly action: CascadeAction;
  /** Why this disposition and not the other one. Read by humans, not by code. */
  readonly why: string;
}

/**
 * BOOSTS AND QUOTES — the one genuinely contested pair, decided here once.
 *
 * The question is what happens to OTHER people's posts that point at a post
 * being destroyed. The repo already answered it, twice, in prose that predates
 * channels (`scripts/lib/adminDeletionPreflight.ts` and
 * `scripts/purgeBlockedDomainContent.ts`), and this follows that answer rather
 * than inventing a channel-specific one:
 *
 *  - A BOOST is deleted. Its body is deliberately empty and it renders entirely
 *    from `boostOf`, so once the original is gone it is not degraded content —
 *    it is a placeholder card with nothing behind it. Deleting it removes an
 *    amplification, never an authored thought.
 *  - A QUOTE is KEPT, because the quoter wrote their own words and those words
 *    are not the channel's to destroy.
 *
 * This differs from the prose in exactly one respect, and deliberately. The
 * written policy leaves `quoteOf` DANGLING and relies on hydration soft-failing
 * the lookup forever. Here the field is UNSET instead. The rendered result is
 * identical — `attachNestedContext` resolves a missing quote to null and drops
 * the card either way — but a row that points at nothing is an orphan by the
 * invariant this cascade exists to uphold, while a row that simply is not a
 * quote any more is not. Unsetting is also idempotent, which a dangling pointer
 * is not: a retry cannot tell "already cleaned" from "never cleaned".
 *
 * `parentPostId` / `threadId` get the same treatment for the same reason, with
 * one caveat recorded in their steps below: a channel post cannot be replied to
 * (the reply gate refuses a `channel` author at five sites), so cross-author
 * rows in that shape should not exist at all. They are swept anyway, because
 * "should not exist" is an assumption and a cascade is the wrong place to hold
 * one.
 */
export const CHANNEL_CASCADE: readonly CascadeStep[] = [
  // ---------------------------------------------------------------------------
  // Engagement and derived rows ON the destroyed posts. Each exists only as an
  // attachment to a post, and none carries content of its own.
  //
  // MOST OF THIS BLOCK IS NOT EXECUTED HERE. `services/PostDeletionCascade.ts`
  // already owns "what happens to a reference ON a post that is gone", for the
  // live delete route every user hits, and its `POST_REFERENCE_DISPOSITION` is a
  // `Record` over the preflight's probe list — so a reference type added upstream
  // breaks THAT file's build until somebody decides what to do about it. A second
  // implementation of the same decisions destroys exactly that property, because
  // one of the two will be the one nobody remembers to update. So these steps are
  // DELEGATED: `ChannelDeletionService` hands the whole doomed set to
  // `cascadePostReferences` and reports them under `delegated` rather than with a
  // count of its own. The manifest still names them, because the inventory has to
  // stay complete whoever performs the write.
  // ---------------------------------------------------------------------------
  {
    model: 'Like',
    field: 'postId',
    scope: 'channel-posts',
    action: 'delete-row',
    why: 'A like is an edge to a post; with the post gone it has no subject.',
  },
  {
    model: 'Bookmark',
    field: 'postId',
    scope: 'channel-posts',
    action: 'delete-row',
    why: 'A bookmark points at a post; a saved-list entry for a destroyed post renders as a hole.',
  },
  {
    model: 'PostRecentReplier',
    field: 'postId',
    scope: 'channel-posts',
    action: 'delete-row',
    why: 'A denormalized replier projection for a destroyed post.',
  },
  {
    model: 'Poll',
    field: 'postId',
    scope: 'channel-posts',
    action: 'delete-row',
    why: 'The poll and its votes live inside the row; the post owned it.',
  },
  {
    model: 'Article',
    field: 'postId',
    scope: 'channel-posts',
    action: 'delete-row',
    why: 'Long-form body owned by the post.',
  },
  {
    model: 'Postgate',
    field: 'postId',
    scope: 'channel-posts',
    action: 'delete-row',
    why: 'A per-post quote/embed policy has no meaning once the post is gone.',
  },
  {
    model: 'Postgate',
    field: 'postUri',
    scope: 'channel-post-uris',
    action: 'delete-row',
    why: 'Same row, reachable by AP uri as well as by id; both are swept so a uri-only row cannot survive.',
  },
  {
    model: 'Threadgate',
    field: 'postId',
    scope: 'channel-posts',
    action: 'delete-row',
    why: 'A per-thread reply policy owned by the root post.',
  },
  {
    model: 'Threadgate',
    field: 'postUri',
    scope: 'channel-post-uris',
    action: 'delete-row',
    why: 'The same row reachable by AP uri instead of id; both keys are swept so a uri-only row cannot survive.',
  },
  {
    model: 'Postgate',
    field: 'detachedQuoteUris',
    scope: 'channel-post-uris',
    action: 'pull-from-array',
    why:
      'A channel post that quoted somebody and was detached is listed by uri inside THEIR postgate. The row ' +
      'is theirs and stays; only the entry naming a destroyed post goes.',
  },
  {
    model: 'Notification',
    field: 'entityId',
    scope: 'channel-posts',
    action: 'delete-row',
    why: 'A notification whose subject post is destroyed opens onto nothing when tapped (entityType post/reply).',
  },
  {
    model: 'Notification',
    field: 'entityId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'The SAME column holds an oxyUserId when entityType is "profile" (a follow or a poke). A sweep that ' +
      'only ever read it as a post id leaves those rows pointing at a deleted channel.',
  },
  {
    model: 'EngagementOutbox',
    field: 'postId',
    scope: 'channel-posts',
    action: 'delete-row',
    why:
      'A queued engagement projection for a post that will not exist when it drains. DELEGATED, and the ' +
      'delegate owns the disposition: `PostDeletionCascade` cancels the PENDING rows and keeps the processed ' +
      'ones, because only a pending row can still act on a post that is gone — a processed one is a log entry, ' +
      'and the unindexed scan that would find the rest belongs in a batch job, not on this collection.',
  },
  {
    model: 'FeedInteraction',
    field: 'postUri',
    scope: 'channel-post-uris',
    action: 'delete-row',
    why: 'Ranking telemetry keyed by post uri; it would train affinity on removed content.',
  },
  {
    model: 'RepairFetchFailure',
    field: 'postId',
    scope: 'channel-posts',
    action: 'delete-row',
    why:
      'An admin repair-log row naming a post that no longer exists. Absent from the existing preflight probes, ' +
      'and therefore from `PostDeletionCascade` too — so this one is executed HERE. A reference the delegate ' +
      'has never heard of cannot be delegated to it.',
  },
  {
    model: 'ContentLabel',
    field: 'targetId',
    scope: 'channel-posts',
    action: 'delete-row',
    why:
      'A label on a destroyed post — rows filtered to targetType "post". DELEGATED, since a label on a post ' +
      'that is gone is the same reference whoever deleted the post; the channel-scoped rows in the SAME column ' +
      'are a different question and get their own step below.',
  },
  {
    model: 'ContentLabel',
    field: 'targetId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'The same polymorphic column holds an oxyUserId when targetType is "user": a label applied TO the channel. ' +
      'Nothing else sweeps it — the post-scoped delegate reads the column only as a post id — so a label ON a ' +
      'deleted channel would survive as the last row pointing at it.',
  },
  {
    model: 'ModerationEnforcement',
    field: 'subjectId',
    scope: 'channel-posts',
    action: 'delete-row',
    why:
      'An enforcement record whose subject post is gone. Named `subjectId`, so a scanner keyed on ' +
      '"postId" misses it — which is exactly why the coverage test keys on id SHAPE and not on a name list. ' +
      'Executed HERE: it is not one of the preflight\'s probes, so the delegate has no leg for it.',
  },
  {
    model: 'Report.model',
    field: 'reportedId',
    scope: 'channel-posts',
    action: 'retain',
    why:
      'A report about a destroyed post is KEPT, and deleting it would break something rather than merely lose ' +
      'an audit trail. An inbound CrowdSource decision is matched to local rows by `Report.crowdSourceCaseId`, ' +
      'and `ModerationDecisionWorker` throws a RETRYABLE `ModerationDecisionDeferredError` when a case resolves ' +
      'to no report — so a decision arriving after the reported post was destroyed would back off and retry ' +
      'until it expired. That reason does not depend on WHO deleted the post, so it cannot have two answers ' +
      'depending on the cause: this follows the live delete path (`POST_REFERENCE_DISPOSITION` in ' +
      '`PostDeletionCascade`), which retains it for exactly this reason. `purgeBlockedDomainContent` DOES delete ' +
      'these, deliberately and differently — it removes a blocked instance\'s content wholesale and its cascade ' +
      'owns that call; the divergence is noted here so a reader does not take this for an oversight. The other ' +
      'side is already designed for a vanished subject: `ModerationDeliveryWorker` closes the report as ' +
      'undeliverable rather than retrying, so the row is stranded by being removed, never by being kept.',
  },
  {
    model: 'ModerationOutbox',
    field: 'reportId',
    scope: 'channel-posts',
    action: 'retain',
    why:
      'The delivery job for a Report, kept because its report is now kept: with the report surviving there is ' +
      'nothing orphaned, and deleting the job would strand a report at `queued` that nothing will ever deliver. ' +
      'The one report this cascade still removes is one the channel FILED (`Report.reporter`, which cannot ' +
      'exist — a channel can never be acted as), and even that leaves no stuck job: ' +
      '`deliverReportOutboxEvent` completes an event whose report is gone instead of retrying it. Same ' +
      'deliberate divergence from `purgeBlockedDomainContent` as the step above.',
  },
  {
    model: 'FederationDeliveryQueue',
    field: 'senderOxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'Undelivered outbound activities from the channel. They must go BEFORE the actor delete is broadcast, ' +
      'or a queued Create races the Delete and republishes a post on the receiving instance.',
  },

  // ---------------------------------------------------------------------------
  // Other people's POSTS that point INTO the destroyed set.
  // ---------------------------------------------------------------------------
  {
    model: 'Post',
    field: 'boostOf',
    scope: 'channel-posts',
    action: 'delete-row',
    why:
      'A boost has an intentionally empty body and renders entirely from its original. Dangling, it is a ' +
      'permanent "unavailable" placeholder, so it is destroyed with the original — see the header note.',
  },
  {
    model: 'Post',
    field: 'quoteOf',
    scope: 'channel-posts',
    action: 'unset-field',
    why:
      'The quoter wrote their own words and keeps them; only the pointer goes. Unset rather than left ' +
      'dangling so no row references a destroyed post — see the header note.',
  },
  {
    model: 'Post',
    field: 'parentPostId',
    scope: 'channel-posts',
    action: 'unset-field',
    why:
      'A channel post cannot be replied to, so this set should be EMPTY; swept anyway because a cascade is ' +
      'the wrong place to hold an assumption. A reply that survives keeps its text and loses its "replying to" line.',
  },
  {
    model: 'Post',
    field: 'threadId',
    scope: 'channel-posts',
    action: 'unset-field',
    why: 'Same shape as parentPostId: the thread root is gone, the post keeps its own content.',
  },
  {
    model: 'Post',
    field: 'mentions',
    scope: 'channel-account',
    action: 'pull-from-array',
    why:
      'Other people\'s posts that @-mention the channel. The post is theirs and stays; the mention would ' +
      'otherwise render a link to an account that no longer resolves.',
  },

  // ---------------------------------------------------------------------------
  // The channel's own posts. Deleted AFTER everything above, so that a crash
  // never destroys the ids the steps above are enumerated from.
  // ---------------------------------------------------------------------------
  {
    model: 'Post',
    field: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'The channel\'s posts. The whole point: with the channel gone their only public author is gone.',
  },
  {
    model: 'Post',
    field: 'writtenByOxyUserId',
    scope: 'channel-posts',
    action: 'delete-row',
    why:
      'Carried by the same rows being deleted. It is NEVER used to reattribute a post to its writer: for a ' +
      'channel that did not opt into naming its writers, that would retroactively publish who wrote what — ' +
      'the one promise a channel makes, broken at the moment it is no longer there to answer for it.',
  },
  {
    model: 'Post',
    field: 'laneId',
    scope: 'channel-lanes',
    action: 'unset-field',
    why:
      'Defence in depth. A lane belongs to one publisher and only that publisher\'s posts carry its id, so ' +
      'these rows are inside the deleted set already; the sweep catches a mis-assigned row rather than trusting that.',
  },

  // ---------------------------------------------------------------------------
  // Rows keyed on the channel ACCOUNT.
  // ---------------------------------------------------------------------------
  {
    model: 'Lane',
    field: 'ownerId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Lanes the channel owns. Absent from the existing preflight probes entirely.',
  },
  {
    model: 'LaneMute',
    field: 'laneId',
    scope: 'channel-lanes',
    action: 'delete-row',
    why: 'A reader\'s mute of a lane that no longer exists. Absent from the existing preflight probes.',
  },
  {
    model: 'LaneMute',
    field: 'laneOwnerOxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Same rows reachable by publisher; swept so a mute cannot outlive its lane by either key.',
  },
  {
    model: 'LaneMute',
    field: 'viewerOxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'A channel can never be acted as, so it cannot be a viewer; swept defensively like the other actor-side rows.',
  },
  {
    model: 'UserSettings',
    field: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'The channel\'s settings row, which carries the writer-disclosure decision. Named in prose rather than ' +
      'by its flag: `channelWriterDisclosure.ts` is that flag\'s one reader, and a gate enforces it.',
  },
  {
    model: 'UserSettings',
    field: 'restrictedUsers',
    scope: 'channel-account',
    action: 'pull-from-array',
    why:
      'Another person\'s privacy settings naming the channel as restricted. Their row is theirs and stays; ' +
      'only the entry goes. Carries no id-shaped suffix, so the scanner cannot flag it — listed in ' +
      'EMBEDDED_CHANNEL_REFERENCES too, which is what keeps that blind spot written down.',
  },
  {
    model: 'ActorKeyPair',
    field: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'The channel\'s ActivityPub signing key. Deleted LAST among account rows: outbound deletes are signed with it.',
  },
  {
    model: 'FederatedFollow',
    field: 'localUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Remote accounts following the channel. Read BEFORE deletion to address the Delete(actor) broadcast.',
  },
  {
    model: 'AuthorFollowerSnapshot',
    field: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Denormalized follower counts used by feed ranking.',
  },
  {
    model: 'MentionSignedRecord',
    field: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'The channel\'s MTN hash chain. A channel post does emit a signed record, under the channel\'s own identity.',
  },
  {
    model: 'MentionRepoHead',
    field: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'The head of that chain; orphaned the moment the records go.',
  },
  {
    model: 'MentionUserNode',
    field: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Self-hosted node registration for the channel.',
  },
  {
    model: 'MentionNodeIngestWitness',
    field: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Ingest witnesses for that node.',
  },
  {
    model: 'Notification',
    field: 'recipientId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Notifications addressed to the channel. It has no session to read them, but rows can exist.',
  },
  {
    model: 'Notification',
    field: 'actorId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Notifications naming the channel as the actor; the "X posted" row would name an account that will not resolve.',
  },
  {
    model: 'EngagementOutbox',
    field: 'actorOxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Queued projections whose actor is the channel.',
  },
  {
    model: 'EngagementOutbox',
    field: 'postOwnerOxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Queued projections whose post owner is the channel.',
  },
  {
    model: 'UserBehavior',
    field: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'A viewer-behaviour row for the channel. It cannot be acted as, so this should be empty; swept defensively.',
  },
  {
    model: 'UserBehavior',
    field: 'authorId',
    scope: 'channel-account',
    action: 'pull-from-array',
    why: 'The channel inside another viewer\'s `preferredAuthors` affinity entries; the viewer\'s row is theirs and stays.',
  },
  {
    model: 'UserBehavior',
    field: 'preferredAuthors',
    scope: 'channel-account',
    action: 'pull-from-array',
    why: 'Same array, named as the array rather than the nested id.',
  },
  {
    model: 'UserBehavior',
    field: 'hiddenAuthors',
    scope: 'channel-account',
    action: 'pull-from-array',
    why: 'Another viewer\'s hidden-author list; scrubbed, never deleted.',
  },
  {
    model: 'UserBehavior',
    field: 'mutedAuthors',
    scope: 'channel-account',
    action: 'pull-from-array',
    why: 'Another viewer\'s muted-author list.',
  },
  {
    model: 'UserBehavior',
    field: 'blockedAuthors',
    scope: 'channel-account',
    action: 'pull-from-array',
    why: 'Another viewer\'s blocked-author list.',
  },
  {
    model: 'UserFeedPreference',
    field: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Feed preferences for the channel; defensive, same reason as UserBehavior.',
  },
  {
    model: 'Mute',
    field: 'mutedId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Somebody\'s mute OF the channel. The row exists only to name that pair, so it dies with the channel.',
  },
  {
    model: 'Mute',
    field: 'userId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Mutes BY the channel; defensive, it cannot act.',
  },
  {
    model: 'MuteWord',
    field: 'userId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Muted words owned by the channel; defensive.',
  },
  {
    model: 'Like',
    field: 'userId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'Likes BY the channel on other people\'s posts. Their `stats.likesCount` is decremented in the same step — ' +
      'a surviving post must not keep a count that includes a deleted record.',
  },
  {
    model: 'Bookmark',
    field: 'userId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Bookmarks owned by the channel.',
  },
  {
    model: 'PostSubscription',
    field: 'subscriberId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Subscriptions the channel holds.',
  },
  {
    model: 'PostSubscription',
    field: 'authorId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Other people\'s subscriptions to the channel\'s output; the author they name is gone.',
  },
  {
    model: 'PostRecentReplier',
    field: 'oxyUserId',
    scope: 'channel-account',
    action: 'pull-from-array',
    why: 'The channel inside another post\'s replier projection; that post belongs to someone else.',
  },
  {
    model: 'EntityFollow',
    field: 'userId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Hashtag/list follows owned by the channel; defensive.',
  },
  {
    model: 'FeedInteraction',
    field: 'userId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Ranking telemetry attributed to the channel as a viewer; defensive.',
  },
  {
    model: 'FeedLike',
    field: 'userId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Custom-feed subscriptions held by the channel; defensive.',
  },
  {
    model: 'FeedReview',
    field: 'reviewerId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Feed reviews written by the channel; defensive.',
  },
  {
    model: 'FeedGenerator',
    field: 'createdBy',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Feed generators the channel registered.',
  },
  {
    model: 'Labeler',
    field: 'creatorId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Labeler services the channel created.',
  },
  {
    model: 'Poke',
    field: 'pokerId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Pokes sent by the channel; defensive.',
  },
  {
    model: 'Poke',
    field: 'pokedId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Pokes aimed at the channel.',
  },
  {
    model: 'PushToken',
    field: 'userId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'A channel has no device and no session, so this must be empty; swept so "must be" is enforced, not assumed.',
  },
  {
    model: 'Poll',
    field: 'createdBy',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Polls authored by the channel outside its own posts.',
  },
  {
    model: 'Article',
    field: 'createdBy',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Articles authored by the channel.',
  },
  {
    model: 'Postgate',
    field: 'createdBy',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Quote policies the channel set.',
  },
  {
    model: 'Threadgate',
    field: 'createdBy',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Reply policies the channel set.',
  },
  {
    model: 'ContentLabel',
    field: 'createdBy',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Labels the channel applied.',
  },
  {
    model: 'Report.model',
    field: 'reporter',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Reports filed by the channel; defensive, it cannot act.',
  },
  {
    model: 'AccountList',
    field: 'ownerOxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Lists the channel owns; an ownerless list is unreachable and unmanageable.',
  },
  {
    model: 'AccountList',
    field: 'memberOxyUserIds',
    scope: 'channel-account',
    action: 'pull-from-array',
    why: 'The channel as a MEMBER of somebody else\'s list; the list is theirs and survives one fewer member.',
  },
  {
    model: 'CustomFeed',
    field: 'ownerOxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Custom feeds the channel owns.',
  },
  {
    model: 'CustomFeed',
    field: 'memberOxyUserIds',
    scope: 'channel-account',
    action: 'pull-from-array',
    why: 'The channel as a member of somebody else\'s feed definition.',
  },
  {
    model: 'StarterPack',
    field: 'ownerOxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'Starter packs the channel owns.',
  },
  {
    model: 'StarterPack',
    field: 'memberOxyUserIds',
    scope: 'channel-account',
    action: 'pull-from-array',
    why: 'The channel as a member of somebody else\'s pack.',
  },
  {
    model: 'StarterPack',
    field: 'usedByOxyUserIds',
    scope: 'channel-account',
    action: 'pull-from-array',
    why: 'The channel recorded as having used a pack.',
  },
  {
    model: 'EndorsementOutbox',
    field: 'pendingRemoveOwnerId',
    scope: 'channel-account',
    action: 'delete-row',
    why: 'A queued endorsement retraction naming the channel as owner.',
  },
  {
    model: 'EndorsementOutbox',
    field: 'pendingRemoveMemberIds',
    scope: 'channel-account',
    action: 'pull-from-array',
    why: 'The channel inside another scope\'s pending-removal list; the row belongs to that scope.',
  },
  {
    model: 'Trending',
    field: 'actorIds',
    scope: 'channel-account',
    action: 'pull-from-array',
    why:
      'A trend row naming the channel among its actors. The trend belongs to the term, not the account, so the ' +
      'row survives with one fewer actor. Absent from the existing preflight probes.',
  },
  {
    model: 'FederatedActor',
    field: 'oxyUserId',
    scope: 'channel-account',
    action: 'delete-row',
    why:
      'A channel is a LOCAL account, so no anchor row should ever name it — these are written only for remote ' +
      'actors. Swept so that a mislabelled row cannot survive as the last thing pointing at the channel.',
  },
];

/**
 * Id-shaped fields that do NOT reference an Oxy account or a Mention post, with
 * what each one actually names.
 *
 * This list exists so the coverage test can be exhaustive without being useless:
 * the scanner flags every field whose name looks like an id, which is the only
 * way a NEW reference cannot slip past it, and that necessarily catches topic
 * ids, file ids and run ids too. Each is dismissed once, here, in writing.
 */
export const NOT_A_CHANNEL_REFERENCE: ReadonlyMap<string, string> = new Map([
  ['ActorKeyPair.keyId', 'the key pair\'s own AP key identifier, not an account'],
  ['BlockedDomainPurge.runId', 'an admin purge run, not an account'],
  ['BlockedDomainPurgeRun.runId', 'an admin purge run'],
  ['BlocklistProposalRun.runId', 'a blocklist proposal run'],
  ['ContentLabel.labelerId', 'the Labeler service that emitted the label'],
  ['CustomFeed.sourceListIds', 'AccountList ids the feed draws from'],
  ['CustomFeed.topicIds', 'topic ids'],
  ['EndorsementOutbox.sourceId', 'the starter-pack or list id the scope belongs to'],
  ['EngagementOutbox.federationActivityId', 'an ActivityPub activity id'],
  ['EngagementOutbox.relationshipId', 'an Oxy relationship edge id, owned by Oxy'],
  ['FederatedActor.publicKeyId', 'a remote actor\'s AP key id'],
  ['FederatedFollow.activityId', 'the AP activity that created the follow'],
  ['FederatedMediaCache.oxyFileId', 'an Oxy S3 file id; the cache is keyed on a remote URL, never on an account'],
  ['FederatedMediaCache.posterFileId', 'an Oxy S3 file id for an extracted video poster'],
  ['FeedLike.feedId', 'the CustomFeed being subscribed to'],
  ['FeedReview.feedId', 'the CustomFeed being reviewed'],
  ['Gif.klipyId', 'an upstream GIF provider id'],
  ['Gif.mp4FileId', 'an Oxy file id'],
  ['Gif.previewFileId', 'an Oxy file id'],
  ['MentionNodeIngestWitness.recordId', 'a signed-record id within a chain'],
  ['MentionRepoHead.headRecordId', 'the signed record at the head of a chain'],
  ['MentionSignedRecord.recordId', 'the record\'s own id'],
  ['ModerationEnforcement.caseId', 'a CrowdSource case id; CrowdSource owns cases'],
  ['ModerationEnforcement.decisionId', 'a CrowdSource decision id'],
  ['ModerationEvent.caseId', 'a CrowdSource case id'],
  ['ModerationOutbox.caseId', 'a CrowdSource case id'],
  ['ModerationOutbox.eventId', 'a CrowdSource event id'],
  ['Post.activityId', 'the AP activity id of a federated post; a channel post is local'],
  ['Post.actorUri', 'the remote actor uri of a federated post; never set for a local channel'],
  ['Post.articleId', 'the Article row the post owns, deleted via Article.postId'],
  ['Post.eventId', 'an event attachment id'],
  ['Post.pollId', 'the Poll row the post owns, deleted via Poll.postId'],
  ['Post.roomId', 'a Syra live-room id, owned by Syra'],
  ['Post.syraPodcastId', 'a Syra podcast id, owned by Syra'],
  ['Post.topicId', 'a topic id'],
  ['PushToken.deviceId', 'a device identifier'],
  ['Report.model.crowdSourceCaseId', 'a CrowdSource case id'],
  ['Report.model.crowdSourceReportId', 'a CrowdSource report id'],
  ['Report.model.decisionId', 'a CrowdSource decision id'],
  ['TopicStats.topicId', 'a topic id'],
  ['TrendGraph.edges', 'term-to-term co-occurrence edges, not accounts'],
  ['Trending.topicId', 'a topic id'],
  ['UserBehavior.topicId', 'a topic id'],
  ['UserSettings.labelerId', 'a subscribed Labeler service'],
  ['UserSettings.mentions', 'the "who may mention me" privacy setting — an enum, not a list of accounts'],
  ['UserSettings.syraPodcastId', 'a Syra podcast id'],
  ['UserSettings.syraTrackId', 'a Syra track id'],
  ['EntityFollow.entityId', 'a hashtag or list id; entityType is never "user"'],
  [
    'FederatedFollow.remoteActorUri',
    'the REMOTE side of a follow edge. A channel is a local account and can never appear here; the channel\'s ' +
      'own rows are deleted by `localUserId`',
  ],
]);

/**
 * References that live INSIDE a string or a `Mixed` blob, where no schema path
 * names them.
 *
 * This list exists because the coverage test is structurally blind to them: it
 * reads declared schema fields, and `author|<oxyUserId>` inside a feed
 * descriptor, or `params.authorIds` inside a `Schema.Types.Mixed`, is not a
 * declared field. Saying so out loud is the point — a gate whose blind spot is
 * undocumented gets mistaken for a complete one, and the next person to add an
 * embedded reference has no way to know this file wanted to hear about it.
 *
 * Each entry names how the cascade reaches it, or states that it deliberately
 * does not and why that is harmless.
 */
export const EMBEDDED_CHANNEL_REFERENCES: ReadonlyMap<string, string> = new Map([
  [
    'MentionSignedRecord.rkey / .subjectDid / .envelope',
    'A post record\'s `rkey` IS the `Post._id`, and the DID embeds the oxyUserId. REACHED: the whole chain is ' +
      'deleted by `oxyUserId`, so no per-field sweep is needed.',
  ],
  [
    'MentionRepoHead.subjectDid',
    'Embeds the channel\'s oxyUserId. REACHED: the row is deleted by `oxyUserId`.',
  ],
  [
    'UserSettings.privacy.restrictedUsers',
    'Another person\'s settings naming the channel as restricted. SCRUBBED by the cascade as an explicit ' +
      '$pull, because their settings row is theirs and only the entry goes.',
  ],
  [
    'FederationDeliveryQueue.activityJson.actor / .object',
    'The sender actor uri and the post uri inside a queued activity. REACHED twice, from both ends: every row ' +
      'the CHANNEL queued is deleted by `senderOxyUserId` before the actor Delete is broadcast, and a row ' +
      'anybody else queued that NAMES a doomed post is cancelled by the delegate (`PostDeletionCascade`), which ' +
      'owns that disposition — pending rows only, since a delivered row is a log entry and the three ' +
      '`activityJson` paths are unindexed.',
  ],
  [
    'CustomFeed.definition.sources[].params.authorIds',
    'A legacy account-source feed can pin the channel by id inside a Mixed blob. NOT REACHED — a Mixed ' +
      'sub-path cannot be indexed or filtered reliably, so the cascade leaves it. Harmless: the source ' +
      'resolves the id through the ordinary author path, which returns nothing once the account is archived, ' +
      'so the feed loses a contributor rather than breaking.',
  ],
  [
    'Like.source / FeedInteraction.feedDescriptor / UserFeedPreference.savedFeeds[].descriptor',
    'Ranking telemetry and saved feeds can embed `author|<oxyUserId>` or `lane|<laneId>`. NOT REACHED for ' +
      'third-party rows: these are provenance labels, not pointers — nothing dereferences them to render, and ' +
      'a descriptor naming a gone author simply ranks nothing. The channel\'s OWN rows are deleted outright.',
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
