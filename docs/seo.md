# Public search indexing

Mention serves the same Expo application shell to browsers and crawlers. The
backend provides the initial title, description, canonical URL, robots directive,
Open Graph fields and JSON-LD. The frontend `SEO` component keeps those head
fields current after client-side navigation.

## Head metadata handoff

The renderer marks its title, meta, canonical and JSON-LD elements with
`data-mention-seo="true"`. A ready route adopts those fields; navigating away
also retires the initial metadata. Proven aliases preserve the original request
identity separately from the canonical URL until their profile is ready.

Initial post metadata remains authoritative because the backend evaluates raw
safety and visibility signals that the hydrated client DTO does not contain.
When navigating client-side to a post without that server proof, use generic
`noindex,nofollow` metadata without body text, content-derived images or structured
data. A direct request for an eligible public URL still receives indexable head
metadata. Do not infer eligibility from `metadata.isSensitive` alone.

## The first frame (public post pages)

A public, ungated post page carries its content in the initial HTML: the
author (linked), the words (with real links; someone else's link is
`rel="nofollow ugc"`), the media with alt text (the author's, else "Image by
<author>") and its box reserved, the time and the counts
(`packages/backend/src/services/webshell/prerender.ts`). It is laid out like the app's mobile post
screen (measured on the live app at 412 px) and painted with the document's
theme tokens, as a fixed layer over `#root` — never inside it, because React's
first commit clears its container and the app first draws its loading states.

The app boots underneath, untouched. When the route has committed the same
content (`<SEO ready>`) and its own `<h1>` is on screen, `packages/frontend/lib/prerender.ts`
fades the layer out (160 ms) and removes it; navigating elsewhere first, or
eight seconds after the app mounts, removes it too. A reader without
JavaScript keeps the layer. Measured on a local production export through the
real renderer (Lighthouse mobile, applied Slow 4G and 4x CPU): an image post's
LCP 2.0–2.15 s and CLS 0.005, against FCP ~10.6 s and LCP ~14.5 s without it.

Only a page the web shell already renders for anyone gets a frame: public,
published, a visible author, no content warning, not a boost (whose frame would
put the original's words under the booster's name). The frame is built from the
same hydrated post as the card and cached with it (`post:semantic-v3`); the
visibility verdicts are this request's own. Profiles have no frame yet: the app
paints a profile in its owner's colour and banner, which the document cannot
know before the app runs.

The #1211 lesson stands: the frame must look like the app's screen, or the
handover is the flash #1211 removed. Change the post screen's layout, and change
`prerenderStyle` with it.

## Theme before JavaScript

The exported `index.html` starts with Bloom's theme bootstrap
(`packages/frontend/scripts/web-theme-prepaint.mjs`: `getThemeBootstrap`, the default preset in
light and dark plus a 1.5 KB script that reads the saved theme), and the
provider adopts it (`prepaintTheme={THEME_PREPAINT}`). `global.css` no longer
paints a fixed `#0b0b0f`, and the web splash stays light on a light document.
The script is inline; the backend authorizes exactly its bytes by a SHA-256 read
from the document itself (`inlineScriptHashes`), so a Bloom upgrade needs no
backend change, and a missing hash only leaves the OS preference to decide.

## The LCP image

A post page preloads its first image at the exact URL the media card requests
(`<link rel="preload" as="image" fetchpriority="high" data-mention-lcp>`), and
that card loads it eagerly at high priority (`packages/frontend/lib/lcpImage.ts`) instead of
expo-image's default `loading="lazy"`. Every image without author alt text is
labelled "Image".

## Profile structured data

A public profile's JSON-LD is a `ProfilePage` whose `mainEntity` is a `Person`
or an `Organization`, from the AS2 type `@oxy.so/federation` announces for the
account's kind (`schemaOrgProfileType`): `Person` for a personal account,
`Organization` for every other kind — schema.org has no type for a bot or an
online community, and Google reads a profile's entity only as one of the two. A
post's author uses the same mapping. The entity carries name, `@handle`, bio,
avatar, its URL, `sameAs` for its public links, followers as
`interactionStatistic` and posts written and accounts followed as
`agentInteractionStatistic`.

A federated profile is an Oxy account Mention minted when it first resolved the
actor, so its Oxy `createdAt` is a discovery date and its Oxy follow graph holds
only the follows made through Mention. Its `dateCreated` and counts come from the
origin (the cached actor row, `remoteProfileStats`), are omitted when the origin
did not report them, and its `sameAs` names the origin actor. Never emit
Mention's own figures for a remote account.

A profile without a bio still gets a generated description; the JSON-LD
`description` stays the person's own words only.

## Post structured data

A post page's title is the author then the opening of the post, cut at a word
(`Nate on Mention: "Mention federates with…"`); a post with no words falls back
to the author and gets a generated description. Its JSON-LD is a
`SocialMediaPosting` read by `text` (not `articleBody`), with its dates,
language, images, videos as `VideoObject` (poster as thumbnail; described by
its alt text, else the post, else who posted it), the author as a `Person` (a
channel's as an `Organization`) linked to their canonical profile, likes and
boosts as `interactionStatistic` and replies as `commentCount`. A count the
author hid is `null` and omitted. An indexed post also lists its newest
public replies as `comment`s — read fresh on every request, never from the card
cache, and only those without a content warning by authors who are public and
indexable. An author who fails to resolve for one request makes it a 503, not
an hour-cached "Unknown user" card with no profile to link. `og:image` is always an image — a video's poster, never its
file — and an avatar fallback is a `summary` card.

The post page's `<h1>` is the focused post's author (with their profile link
inside it); the screen's "Post" label is an `<h2>`.

A boost's page repeats someone else's post, so it is `noindex,follow` and is
not in the sitemap; the original is the URL to index.

## Site identity and hashtags

The homepage carries `Organization` (name, logo) and `WebSite` (name,
`alternateName`) JSON-LD — what Google reads for the site name and logo beside
every result. It is defined once, `siteStructuredData` in
`@mention/shared-types/seo`, because the server's homepage and the app's head
both emit it. A deployment's `branding.logoUrl` replaces the default logo.

`/hashtag/<tag>` (apex only) is served with the tag normalized the way posts
store it (`normalizeHashtag`), so every spelling has one canonical URL; it is
indexed only while a listable post carries the tag.

## Breadcrumbs and search

Every indexed page's JSON-LD carries its `BreadcrumbList` — the site, then the
author for a post, then the page — on the page's own entity
(`ProfilePage.breadcrumb`, `CollectionPage.breadcrumb`, a post's
`mainEntityOfPage.breadcrumb`), so the one document the app adopts after it
loads keeps it. The homepage's `WebSite` names the search page as a
`SearchAction` (`/search?q=`). Google retired the sitelinks search box in
November 2024, so that draws nothing in its results; it is schema.org's own
statement of how the site is searched. `structuredDataRules.test.ts` checks
every document against Google's required properties, offline.

## Interstitials

Mention shows no interstitial over public pages. Anonymous visitors get the
sign-in banner instead, because Google indexes the page underneath and ranks
down pages an interstitial hides.

## URLs

A handle's `@` stays literal in every URL Mention writes —
`/@user@instance`, never `/@user%40instance`. It is a legal path character,
and it is the URL the app routes and people share; a percent-encoded canonical
is a second URL for the same page. `canonicalProfilePath` is the one place a
profile URL is spelled, for the canonical, the sitemap and the channel redirect.

## Crawlable links

A search engine follows `<a href>`, never press handlers. Every in-app
destination a reader can click — a post's time, an author's name, a "Reposted
by" row, a mention or hashtag in text — is an expo-router `Link`, which renders
an anchor on web and still navigates in-app on a plain click. Use `asChild`
with a `Text` child: a `Touchable`/`Pressable` child replaces the link's web
click handler with its own, so the browser does a full page load. A link
inside a pressable row stops the press from reaching the row.

A profile link read out of plain text — a typed `@user@instance`, a pasted
profile URL — names an account nobody has checked exists, so it is
`rel="nofollow"` (`LinkifyEntity.unverified`); each one naming nobody was a
404 in Search Console. A hydrated mention is a resolved account and is
followed.

The profile's display name is the page's `<h1>` (`UserName asHeading`).

## Verification

Use a production web export and the real backend renderer. Verify that the
app's own body is unchanged (the first frame is a sibling layer ahead of
`#root`), that `#root` is never hidden, that the frame matches the app's screen
at the handover (a filmstrip at 4x CPU shows the same layout before and after),
and that it is gone once the route is ready.
Assert a single title/canonical/robots/description after readiness, no transient
home pathname on deep-link loads, and removal of stale metadata after navigation,
and that a profile renders one `<h1>` and anchors to its posts
(`packages/e2e/tests/seo-handoff.spec.ts`).

## Eligibility

- Only Mention's own content is indexed. A federated post or profile (a copy of
  a page on another server: the fediverse, Bluesky, a bridged network) is
  served to everyone as before, but `noindex,follow` and out of the sitemaps.
  A federated post's `rel=canonical` names its page on the origin
  (`federation.url`, the note's HTML `url`) when the origin gave one; its
  `og:url` stays on Mention, so a shared link still opens here. A federated
  profile keeps its own canonical: Mention stores the origin's actor id, not its
  HTML profile URL, and a canonical must name an HTML page. The boundary is the
  one nodeinfo counts by: a post is another server's when it carries a
  `federation_activity_id` or a `federation_actor_uri` (a local post's own
  content warning also lives on the federation columns). Measured 2026-11-28:
  271,013 profile URLs in the sitemaps, 23 of them local; 3,077 local posts
  against 10.66M external ones.
- Do not `Disallow` federated URLs in `robots.txt` yet: a crawler that cannot
  fetch a page cannot see its `noindex`, and keeps it indexed without content.
  Block them only after Search Console shows them dropped.

- Profiles must resolve through Oxy's public profile endpoint and have public
  Mention profile visibility.
- A post page asks whether Oxy serves each author's public profile through a
  short cache (`packages/backend/src/services/accounts/oxyAuthorVisibilityCache.ts`): a public answer for 60 s,
  a hidden one for 5 min, a failure never (the page is a 503). Oxy's
  user-invalidation broadcast and an erasure evict it at once, so an archived or
  restricted author leaves crawled pages promptly; the TTLs only bound a lost
  message. Asked fresh on every page view, crawler volume was Oxy volume.
- An account can opt out of search engines (Settings → Privacy → "Show in
  search engines", `privacy.searchEngineIndexing`). Its profile and posts stay
  public to people — the pages render and unfurl as before — but are served
  `noindex,follow` and are left out of the sitemap. A boost of an opted-out
  author's post is `noindex` too: its words are theirs.
- A federated account has no Mention settings; its choices at its origin feed
  the same policy (`mentionProfileSeoPolicy`, `publicSeoPost`), read from its
  `federated_actors` row (`federatedSearchOptOutSql`). It is `noindex` and out
  of the sitemap when it is not `discoverable`, when it is an ActivityPub actor
  that did not opt in with `indexable: true` (Mastodon's rule: `false` and
  absent alike), or when it hides from signed-out readers (Bluesky's
  `!no-unauthenticated` self-label). That last one also makes the page
  unavailable signed out and withholds its posts from every signed-out
  hydration, through the private-profile gate.
- Posts must be published, public, safe for discovery, and authored by a public
  profile.
- Sensitive posts may still produce privacy-safe link previews, but are marked
  `noindex,nofollow` and never expose their body or image in the initial HTML.
- Missing public entities return `404`; dependency outages return `503` with
  `Retry-After`, preventing soft-404 indexing.

## App routes, soft 404s and crawl budget

Every apex path the web shell does not render itself is answered with the
app's `index.html`. `appRoutePolicy` (in the apex proxy) says what it is: a path
whose first segment no app route starts with is a real `404` (the body is still
the app, which shows its not-found screen), and a signed-in tool or form
(settings, compose, notifications, search, `…/edit`, `…/create`, a post's
reposts or quotes) carries `X-Robots-Tag: noindex`. Every other route is left
to its in-app `<SEO>`. The route list is checked against
`packages/frontend/app` by `appRoutePolicy.test.ts`: a new top-level route must
be added there, or its page answers 404.

`robots.txt` disallows the unbounded URL spaces: search results, a post's
reposts, quotes, boosts and corrections, a profile's followers, following and
suggestion lists, and the signed-in tools. A page request with click-tracking
parameters (`utm_*`, `fbclid`, `gclid`, …) is sent with one `301` to the same
URL without them, other parameters kept.

## Discovery and operations

`/robots.txt` advertises `/sitemap.xml`. The sitemap index links to bounded
profile and post sitemaps under `/sitemaps/`, each with its `<lastmod>` (the
newest of its URLs). They list only Mention's own posts and the local profiles
and channels that wrote them, in one bucket (`SITEMAP_BUCKET_COUNT = 1`): rows
are in id order and post ids are UUIDv7, so a new post lands on the last page
and earlier pages stay as they were. A page holds at most 40,000 URLs, below
the protocol's 50,000. A post's `lastmod` is when its page changed — its
creation, or its last edit — never `updated_at`, which every like moves. A
post's images are listed with Google's image extension (`image:image`). Profile
entries are derived from authors of eligible local posts, then resolved in
bounded batches through Oxy's public bulk-profile gate, which excludes archived
and restricted accounts.

Sitemaps are built in ONE pass, off the request path and off every serving task,
by a scheduled one-shot ECS task (`packages/backend/src/scripts/buildSitemaps.ts`, launched hourly
from the live task definition by oxy-infra `app-mention-sitemaps.tf`) whenever
the cached catalog is six hours old: one grouped
read for every profile shard and one bucket-ordered, streamed read for every post
shard, then the catalog. Requests only read that cache. A shard the catalog does
not list is `404`; an empty cache (a fresh deployment, a flushed Redis) is `503`
with `Retry-After` until the first build lands. Building each shard on demand
cost a full read of the eligible posts per shard (~30 s for a profile shard) and
a crawler walking the index made that ~70% of Mention's database load (#1160).
Responses carry `Last-Modified` (the build time) and an ETag, so a revalidating
crawler gets a `304`, and may be cached for an hour (six at the CDN).

The post read's shards are compressed while its cursor streams and written to
Redis only after its transaction ends, so the read's connection and snapshot are
never held across Redis I/O.

Submit only the root sitemap in Google Search Console and monitor Page Indexing,
ProfilePage markup, crawl failures, and sitemap URL counts. Retired numeric shard
URLs return XML with `410 Gone`, never the HTML application shell.

The production smoke test is `https://mention.earth/@nate`: it must return a
`200`, a self-canonical URL, `index,follow` and valid `ProfilePage` JSON-LD to
both a normal browser user agent and Googlebot. A federated profile
(`/@aida_quilcue@x.com`) returns a `200`, a self-canonical URL, `ProfilePage`
JSON-LD and `noindex,follow`. Visible identity text comes from the
application after it loads.
