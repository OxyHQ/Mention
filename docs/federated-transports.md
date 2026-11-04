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
`…/shared/transportCopies.ts`, `…/activitypub/keylessTransport.ts`,
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

Copies are merged on the inbox, outbox and atproto author-feed paths. A post
fetched as a dependency (a reply parent, a quote) is not refetched just to
merge it. The Graph import still skips a post the bridge already delivered.

## mastox.eu: history only, and why

mastox.eu copies X accounts as a stock Mastodon instance. Its posts carry no
tweet id, no x.com link and no card. Its `published` is when it crawled the
tweet, not when the tweet was written. Nothing in a mastox post proves which
tweet it is, so a bird.makeup copy and a mastox copy of the same tweet cannot be
proven equal. Comparing content cannot prove it either. Measured in production
on the accounts held through both bridges:

- The same account posts identical text several times within an hour (three
  mastox copies of one sentence in 82 minutes; a tweet deleted and reposted two
  minutes later).
- mastox drops media: 5% of its posts carry any, against 34% on bird.makeup.
  "Same media count" would refuse most real pairs.
- Its crawl lag is not bounded, so any time window is a guess.

A wrong merge would attach one post's replies, likes and boosts to a different
post. So the two are never compared. Their time ranges are kept apart instead.
Once an account's keyed transport delivers by subscription, mastox stops being
a source for anything published at or after that moment. Before that moment
mastox is the only source that ever delivered those posts (bird.makeup has no
outbox), so its history is kept and the mastox outbox is still read to fill it.

The moment is the publication time of the first post Mention stored from a
keyed transport of the same account because it follows that transport (an
inbox `Create` or `Announce`). A keyed post fetched as a quote or reply parent
does not count. Until that first delivery, mastox stays live, so an account
whose bird.makeup mirror never delivers is not silenced.

What this rule costs:

- The few tweets mastox stored between the bird.makeup follow and bird.makeup's
  first delivery can be stored twice.
- Once bird.makeup has delivered, mastox stays history-only even after everyone
  unfollows. New posts arrive again only when someone follows the account.

Retweets: mastox flattens them into `RT: @original …` posts, which are dropped.
bird.makeup delivers them as `Announce`s of the original, stored as boosts under
the original author.
