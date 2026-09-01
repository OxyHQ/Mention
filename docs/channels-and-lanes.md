# Lanes and Channels

Deep detail behind the rules in `AGENTS.md` § Post and identity rules.

## Lanes

A named track owned by a **publisher** — one `ownerId`, an Oxy `oxyUserId`. A
channel is an Oxy account, so a channel curating its page and a person
curating their profile are the SAME case; the owner used to be polymorphic
(`ownerType`) and stopped having a second reachable value. A post carries at
most one `laneId` and stays an ORDINARY post: distribution, visibility,
replies and federation are untouched. The lane is a lens, not a destination.

- Per-lane `displayMode`: `mixed` (default, appears on the main tab) · `tab`
  (its own profile tab only) · `hidden` (nowhere on the profile, including
  for the owner).
- **`hidden` is curation, not privacy.** Those posts still reach every feed
  and stay readable at their own URL. Say so in any UI copy, or it gets
  reported as a leak.
- A reader can mute one lane of one publisher (`LaneMute`). Applied in
  `FeedEngine.gatherPool` **and** `runPopularFallback` — the second bypasses
  the first. Scope is FEEDS only, deliberately narrower than muted words: a
  lane mute is a timeline preference, not a safety rule, so search and post
  detail still return the post.
- Descriptor `lane|<laneId>`, ONE param — the lane knows its own publisher.
  `laneSource` gates on publisher visibility **and** on
  `displayMode === 'tab'`; drop either and the descriptor becomes a back door
  into a hidden lane.
- Replies and boosts never carry a lane. `assertLaneAssignable`
  (`utils/laneAssignment.ts`) is the single validator, and its `channelId`
  argument is what keeps a lane with its own publisher — the write path that
  forgets to pass it lets a channel post into a personal lane, which
  deanonymizes the writer (the DTO stays anonymous but the lane tab is
  scoped to one author).

## Channels

A channel is an **Oxy account** (`kind: 'channel'`), not a Mention row.
People follow it **without following its authors**, which is the whole
point, and the decoupling now costs nothing: a channel post is an ORDINARY
post whose author happens to be a channel, so it reaches the Following feed
of the channel's own followers by the same path as anybody else's.

That is the second design. The first modelled a channel as a Mention-local
destination, and the shape it forced is the reason it was replaced — worth
knowing, because every simplification below is the removal of one of its
workarounds.

- **The channel IS the author.** `post.oxyUserId` and `post.authorship` carry
  the CHANNEL account, so `post.user` is the channel with its real avatar,
  name and handle. The DTO has no `channel` field and there is no degraded-
  author path: the old model could not fabricate a `PostUser` from a
  Mention row (Oxy owns identity), so it shipped a deliberately degraded
  `user` — `'Unknown user'`, empty handle — with the real signature beside
  it. Two identities on one post, and the renderer chose. Re-adding a
  `channel` field re-creates that choice.
- **The human who wrote it is `Post.writtenByOxyUserId`, never in
  `authorship[]`.** Putting them in `authorship` would both break the
  channel's anonymity and put the post back on their own profile and their
  followers' timelines. `__tests__/channelAccountSchema.test.ts`
  mutation-tests exactly that against REAL ROWS. The `channel_id is null`
  exclusion that used to hide it was dropped with the column by
  `0017_a_channel_is_an_account`, so the authorship placement is now the
  only thing holding the property up.
- **`UserSettings.channel.signPosts` (keyed on the CHANNEL's `oxyUserId`) is
  the WHOLE disclosure decision, and it is made on the server.** There is
  deliberately no `writtenByOxyUserId` on the DTO — shipping the raw id
  whenever the column holds one would end the anonymity of every channel
  that did not opt in. When the channel signs, `PostHydrationService`
  appends the writer to `authors[]` as `role: 'writer'` (`PostBylineRole`,
  wider than the `authorship` role on purpose), so the EXISTING
  collaborative byline draws the avatar cluster and the "A and B" name row —
  the writer is a second author, never a separate line, and `user` stays
  the channel. It fails CLOSED at three independent points: the author must
  resolve as `kind: 'channel'`, the settings row must say
  `signPosts === true` (a missing row, an unset flag or a failed lookup are
  all "no"), and an undisclosed writer's id is never even sent to the
  identity batch. Mutation-tested in
  `__tests__/services/postHydrationChannelWriter.test.ts` — including the
  truthy-non-boolean fixture that tells `=== true` from `Boolean(...)`.
- **`writtenByOxyUserId` must be in all FOUR hydration projections**
  (`mtn/feed/FeedAPI.ts`, `controllers/feed.controller.ts`,
  `services/ThreadSlicingService.ts`, `routes/search.ts`). Missing from one,
  the writer hydrates `undefined` with no error and the same post names its
  writer on a feed row but not as a thread parent.
- **A channel can never be acted as.** `isDelegatedActAsEligibleKind`
  (`@oxyhq/contracts`) refuses `channel`, so no session can be minted whose
  subject is a channel — which is why channel accounts cannot appear in the
  account switcher structurally, not by a UI filter. Publishing as one
  therefore goes through `CreatePostRequest.publishAsOxyUserId`, not a
  session switch.
- **`services/publishAsAccount.ts` is the ONE gate** for "may this person
  act for that account", answered out of Oxy's account graph
  (`listAccountMembers`) with the CALLER's own bearer. It fails closed: an
  unresolvable membership is a refusal, because allowing publishes a post
  under another account's identity. `PUT /profile/settings/:userId` reuses
  the same gate, so whoever may publish as a channel is whoever may
  configure how it signs.
- **Managing a channel's post answers to CURRENT membership, never to
  `writtenByOxyUserId`.** `services/postManagementAccess.ts`'s
  `postManagementRefusal` is the one gate for all seven management routes
  (edit, edit-source, settings, lane move, delete, publish-early, insights)
  with NO per-route opt-out — the stored writer column is written once at
  creation and never revised, so honouring it would let a removed member
  keep destroying, rewriting, pinning and measuring the channel's work.
  Only "the caller IS the authoring account" is free. The DTO's
  `viewerState.isOwner` deliberately still reads the writer column and
  therefore diverges: a departed writer is drawn a menu every route 404s.
  Do not "fix" that by narrowing `isOwner`.
- **Publishing as another account is NOT channel-only, and the two families
  need different authorities.** A `channel` can never be acted as, so
  accepted membership IS the whole right. An `organization` / `project` /
  `bot` CAN be, so publishing under its name is the same authority as
  becoming it and additionally requires `account:act_as`, read off
  `AccountMember.permissions` and never inferred from `membership.role` — a
  role list here is a second copy of Oxy's role→permission map, and the
  copy is what goes stale. Eligibility asks `isDelegatedActAsEligibleKind`, not
  `kind !== 'personal'`, so a kind Oxy adds later is refused rather than
  inherited.
- **`replyPermission: ['nobody']` is forced by the author's KIND, never by
  "published as an account".** Keyed on the latter, an organization's post
  persists uncommentable while the reply gate — which refuses only a
  `channel` author — happily admits replies. This is why the gate RETURNS
  the resolved kind instead of the reply rule performing a second lookup
  that could answer differently.
- **A thread takes BOTH placements of `publishAsOxyUserId`** (per-entry wins
  over batch-level); a `beast` batch takes only the per-entry one. Thread
  continuations are replies, and publishing a reply as another account is
  refused outright, so both thread shapes need a verified hole in that
  rule: `assertContinuesOwnThread` (one account's own text end to end) and
  `assertAnswersOperatedAccount` (two accounts the caller operates talking,
  refused the moment a channel is at either end or at the thread's root).
  `utils/threadContinuation.ts` holds both. A channel's thread speaks with
  ONE voice — a second account in it would be a reply to the channel — and
  the refusal names the offending channel. A beast batch may mix accounts
  freely, since no entry there replies to another.
- **Known gaps, both failing closed:** an organization's post is anonymous
  with no way to sign it (writer disclosure is gated on `channel` +
  `signPosts`), and inherited memberships are invisible to the gate because
  `GET /accounts/:id/members` returns DIRECT rows only.
- **A channel post DOES federate and DOES emit an MTN record**, under the
  channel's own identity. Both were skipped in the first design solely
  because the post was authored by a person and those are author surfaces;
  with the channel as the author the exception has no subject.
- **No replies, ever.** The gate reads the post AUTHOR's account `kind`,
  never `replyPermission` (a settings write could flip that), at five
  sites: above the whole permission block in `createReply` (skipped
  entirely for `anyone`, containing an unconditional escape for the
  author), `POST /posts` (no parent lookup at all), `updatePostSettings`,
  and both federated ingest paths — where it drops silently, because a
  throw retries the inbox job forever and a 4xx ends delivery from that
  instance permanently.
  - **The rule is enforced on the way IN, and cannot be on the way out.**
    AS2 has no field for it that anything in the wild honours (we emit no
    `interactionPolicy`), so a remote instance shows a reply box under a
    channel's Note and accepts the reply locally — Mention drops it on
    arrival. That divergence has been true of every single channel post
    since channel posts began federating.
- **A channel post has NO 30-minute edit window — it has a correction trail
  instead, and the trail is the half that matters.** A publication is
  expected to fix what it published however long ago, so `updatePost` skips
  the window for a `channel` author (`isChannelAccount`, the same identity
  read the reply gate uses). That is only acceptable BECAUSE every change
  to a published channel post's body appends a `post_corrections` row
  holding what it said before: permanent editability without the trail is
  strictly worse than the window, since it lets a publication silently
  rewrite what people read.
  - Three conditions, each excluding a case with nothing to be accountable
    for: a channel author, a change to the BODY (a pin, a lane move or a
    media swap is not a correction, and `isEdited` never counted one
    either), and a post that was already `published` before the edit (a
    draft or scheduled post has no readers). A personal post keeps its
    window and records nothing.
  - `isChannelAccount` fails soft to `false`, which here means the window
    APPLIES. During an identity outage a late correction is refused rather
    than allowed; refusing an edit is the recoverable direction.
  - The trail carries NO author, though it stores one.
    `post_corrections.corrected_by_oxy_user_id` is written for audit and
    never selected by `listPostCorrections` — a correction is made by
    exactly the writer `signPosts` exists to keep undisclosed, so serving
    it would route around that setting.
  - `posts.correction_count` counts corrections MADE, never rows retained,
    and is the source of the revision number (`update … returning` in one
    statement, so two concurrent corrections cannot both claim revision N).
    Retention keeps revision 1 — the post AS PUBLISHED — plus the most
    recent `MAX_RETAINED_POST_CORRECTIONS - 1`; a gap in the surviving
    `revision` numbers is where an intermediate body was dropped.
  - Nothing changes in federation or on the MTN chain, and neither needs
    to. The existing `Update(Note)` with its `updated` stamp is the only
    interoperable edit signal. The chain already IS an append-only signed
    trail: `emitPostCreated` re-emits under the SAME rkey and
    `mention_signed_records` has no unique index on
    `(oxy_user_id, nsid, rkey)`, so every version persists, signed, ordered
    by `seq`, LWW-materialized to the newest.
  - `GET /posts/:id/corrections` is PUBLIC and reuses the post's own ACL by
    hydrating it and 404ing when hydration drops it.
- **Putting a channel post on your own profile is a BOOST.** `EXCLUDE_CHANNEL_POSTS`
  is gone: with the channel as author, the authorship matchers exclude the
  post from the writer's surfaces on their own.
- **A channel's page is `/c/<handle>`** — that account's author feed, served
  by the ordinary profile machinery. There is no `channel|<id>` descriptor
  and no `ChannelFollow`/`ChannelMember` model; following is a normal Oxy
  follow and membership lives in the account graph. `webShell.routes.ts`
  redirects `/@handle` to `/c/<handle>` for a channel **after** the
  ActivityPub-Accept branch — never redirect an AP endpoint path.
- **A notification addressed to a channel needs READ-TIME recipient
  expansion, because no session can ever BE the channel.**
  `isDelegatedActAsEligibleKind('channel') === false` refuses a channel as a session
  subject, yet a channel post's `post.authorship` owner IS the channel, so
  engagement notifications (`createPostAuthorNotifications`) are naturally
  addressed to the channel's own id. `GET /notifications`
  (`services/notificationInbox.ts`) resolves the READER's own
  operated-channel ids at request time (`listOperatedChannelIds` in
  `publishAsAccount.ts`) and reads both id sets, rather than fanning out to
  each operator at write time — the write path stays untouched and no
  membership snapshot can go stale. Recipients are every ACTIVE operator,
  never `Post.writtenByOxyUserId` — routing by the writer would turn each
  operator's own notification stream into a per-post partition that
  discloses exactly what `signPosts` exists to keep undisclosed. Known gap:
  push notifications don't reach operators, because that needs the member
  roster at WRITE time and no service-auth member read exists for it yet.
- **You cannot block, report, or mute an account you operate — refused on
  the SERVER, not just hidden from a menu.**
  `services/operatedAccountAccess.ts`'s `viewerOperatesAccount` answers "do
  I operate this account" by reusing `assertCanPublishAsAccount` verbatim
  (never a second membership reader). `POST /reports` and `POST /mute`
  both refuse with 400, not 403 — an operator has MORE authority over the
  account than a stranger, so "forbidden" states the opposite of what's
  true. It fails toward ALLOWING on an unresolvable answer, the opposite
  direction from the publish gate it wraps, because block/report/mute are
  protective and the caller is usually the one needing protection. The
  block refusal itself lives in oxy-api, not Mention — `oxyServices.blockUser`
  calls oxy-api's `POST /privacy/blocked/:id` directly.
