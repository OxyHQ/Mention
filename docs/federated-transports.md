# Federated transports: one person, several roads, each post once

A person on another network can reach Mention through several transports at
once:

| Network   | Transports                                  | Post id the transport carries          |
| --------- | ------------------------------------------- | -------------------------------------- |
| X         | bird.makeup                                 | the tweet id (`…/statuses/<tweet id>`) |
| X         | mastox.eu                                   | none: its own Mastodon ids             |
| Instagram | kilogram.makeup, Meta Graph API             | the shortcode                          |
| Bluesky   | native atproto, Bridgy Fed (`bsky.brid.gy`) | the at-URI                             |

Mention reads from all of them and stores each upstream post once. Code:
`packages/backend/src/connectors/shared/upstreamPostKey.ts`,
`…/shared/transportCopies.ts`, `…/activitypub/transportHandoff.ts`,
`…/connectors/transportFollows.ts`. The list of mirror hosts and what their
post ids look like is `packages/backend/src/utils/federation/mirrorTransports.ts`;
a new bridge is one entry there.

## Following follows every transport

Following a federated account follows every transport of that account, and
unfollowing undoes every transport the follower follows. Oxy decides which
transports exist: it lists them in `externalIdentities` (same `canonicalAcct`,
one entry per actor) and registers an account's routed transport (bird.makeup
for X, native atproto for Bluesky) when another bridge found it first. Mention
never derives a transport itself. The other transports are followed in the
background after the one the caller named. Another account the same person
holds on another network is a different account and is not followed.

Existing follows get their missing transports from the
`followAccountTransports` one-shot (`DRY_RUN=true` first).

## The upstream post key

Each transport that carries the network's own post id gives the post a key:
`x:<tweet id>`, `instagram:<shortcode>` or `bluesky:<at-uri>`. Every federated
post write stores it in `post_source_keys`, where it is UNIQUE, in the same
transaction as the post. Every "is this already here?" check finds a post by
its object id or by its key. So a tweet that bird.makeup delivers under two
handle spellings, or a Bluesky post read natively and through Bridgy Fed, is one
post. A Bluesky repost seen both ways is one boost. Posts stored before the key
existed get it from the `backfillUpstreamPostKeys` one-shot.

## Two copies of one post are merged, not picked

When a second transport delivers a post that is already stored, its copy is
merged into the stored post. What each copy said is kept in
`post_transport_copies`. The post is the merge of all copies, computed in a
fixed order, so the result does not depend on which copy arrived first.

**Order.** The network's own protocol or API (native atproto, the Graph API)
comes before a bridge. Ties are broken by object id.

**Rules, field by field:**

- **Published time, URL, reply target.** Taken from the first copy in that
  order that has one. A missing value is filled. When copies disagree, the
  higher-ranked copy wins.
- **Quoted post and parent post.** Filled when the stored post has none, never
  replaced: replacing one would move reply counters and audiences because two
  bridges disagree.
- **Text.** Taken from the first copy whose text is not a truncation of another
  copy's. A truncation is text that, without a trailing `…`, is a strict prefix
  of the other text. A complete copy beats a cut-off one whatever their rank.
- **Media.** One copy's set, never a union of two copies of the same image.
  That is the text copy's set when it has media, else the first copy that has
  any. An item missing alt text gets it from another copy only when that copy
  has the same number of items, of the same types, in the same order.
- **Language and content warning.** From the first copy that has one.
- **Sensitive.** Set if any copy says so.

**Edits and deletes.** An `Update` from any transport that delivered a copy is
that copy's new content, merged again by the same rules. A `Delete` from one
transport removes only its copy while another copy remains. The post is deleted,
with its counters, when its last copy goes. Only the transport that delivered a
copy may edit or delete it.

Copies are merged on the inbox, outbox, atproto author-feed and Instagram Graph
import paths. A Graph import of a post kilogram.makeup already delivered merges
into it, its caption, media and permalink winning (the Graph API is Instagram's
own); a Graph copy is ranked by its `instagram:` object id, since it shares the
kilogram actor. A post fetched as a dependency (a reply parent, a quote) is not
refetched just to merge it.

## mastox.eu and bird.makeup: one handoff per account

mastox.eu copies X accounts as a stock Mastodon instance. Its posts carry no
tweet id, no x.com link and no card; its `published` is when it crawled the
tweet. Nothing in a mastox post names its tweet, so a mastox copy and a
bird.makeup copy of the same tweet can never be matched, and comparing their
content is never done. Measured in production (2026-11-04), on 695 tweets paired
between the two bridges (34 accounts):

- mastox's time is never earlier than the tweet (0 of 695).
- Its lag is short when it keeps up: on the 522 tweets of the last 30 days the
  median is 146 s, p99 466 s, max 1,127 s. When it stalls it catches up days later
  (the >1 h tail, 53 pairs, up to 188 days).
- It carries no replies (0 of 6,686 stored posts) and often no media.

bird.makeup's status id is the tweet id, a snowflake, so a tweet's time is exact.
A follow only adds us to its follower list: its next crawl delivers every tweet
newer than its cursor, including tweets written before our Accept, and an
account it never crawled before gets its whole first timeline page.

**The rule.** Each such account has ONE handoff instant H, and each tweet
belongs to exactly one transport, by the time it was written:

- **Before H: mastox.** A mastox post is stored only when its crawl time is
  before H. Since mastox's time is never earlier than the tweet, that proves the
  tweet was written before H.
- **From H on: bird.makeup.** A bird.makeup post written before H (by its tweet
  id) is not stored: that period is mastox's. Live mastox posts after H are not
  stored.
- **Replies are bird.makeup's,** whatever their time; mastox carries none, so
  none is ever duplicated and an old reply a thread needs is not lost.
- **The rule governs only the account's own timeline:** a post arriving as its
  live item (inbox) or from its outbox. A bird.makeup object Mention needs
  because something references it — the original of a boost, a quoted post, a
  reply's parent or thread ancestor — is stored whatever its time, whenever no
  copy with its tweet id exists. Retweets therefore always show as boosts of the
  original. A mastox object has no tweet id to check, so a referenced mastox
  post stays under the rule.

On the account's own timeline no tweet can be stored twice. The rule reads only
times, whether a post is a reply, and whether it is the account's own timeline
item or a referenced object.

**The residual:** a referenced tweet written before H that mastox ALSO stored
exists twice (its bird.makeup copy and its mastox copy). Measured 2026-11-05: of
the 7 bird.makeup rows written before H on the 3 accounts with a handoff, 2 have
a mastox row with the identical text; of the 9 recorded boost-original and quote
imports on accounts held through both bridges, 0 do. (That measurement compared
text; the runtime never does.)

**H is stored per account** (`federated_transport_handoffs`, keyed by Oxy's
`canonicalAcct`), written once and never moved. It is the time Mention first holds
an accepted follow of bird.makeup for the account — written when the Accept
arrives. If Mention held no mastox post of the account by then, the account's
handoff is "none": bird.makeup takes everything, mastox nothing. Until there is
an accepted bird.makeup follow, mastox stays a source as before.

**What is lost, and its bound:**

- A tweet written shortly before H that mastox had not crawled by H: neither copy
  is stored. The window is mastox's crawl lag at that moment (p99 under 8
  minutes, max under 19 measured); more if mastox was stalled at H.

**Generic.** Which hosts are keyed (their status id is the upstream post id) and
which keyless comes from the mirror registry
(`packages/backend/src/utils/federation/mirrorTransports.ts`). Another keyless
bridge of a network with a keyed one follows the same rule with no new code.
Code: `packages/backend/src/connectors/activitypub/transportHandoff.ts`.

Retweets: mastox flattens them into `RT: @original …` posts, which are dropped.
bird.makeup delivers them as `Announce`s of the original, stored as boosts under
the original author.
