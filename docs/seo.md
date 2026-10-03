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

SEO must not introduce an alternate visible interface. The renderer leaves the
application body unchanged: no injected profile/post article, boot overlay,
hidden replacement content or crawler-specific body. React owns the visible
application throughout startup, including its normal loading states.

Initial post metadata remains authoritative because the backend evaluates raw
safety and visibility signals that the hydrated client DTO does not contain.
When navigating client-side to a post without that server proof, use generic
`noindex,nofollow` metadata without body text, content-derived images or structured
data. A direct request for an eligible public URL still receives indexable head
metadata. Do not infer eligibility from `metadata.isSensitive` alone.

## Profile structured data

A public profile's JSON-LD is a `ProfilePage` whose `mainEntity` is the person
(or, for a channel, the organization): name, `@handle`, bio, avatar, its URL,
`sameAs` for its public links, followers as `interactionStatistic` and posts
written and accounts followed as `agentInteractionStatistic`.

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
language, images, videos as `VideoObject` (poster as thumbnail), the author as
a `Person` (a channel's as an `Organization`), likes and boosts as
`interactionStatistic` and replies as `commentCount`. A count the author hid is
`null` and omitted. `og:image` is always an image — a video's poster, never its
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

## Interstitials

The first-visit welcome modal covers the page, so it is shown only wider than a
phone (`useIsScreenNotMobile`): Google indexes the phone layout and ranks down
pages an interstitial hides. Phones get the sign-in banner instead.

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

The profile's display name is the page's `<h1>` (`UserName asHeading`).

## Verification

Use a production web export and the real backend renderer. Verify that JavaScript-
disabled and delayed-script responses preserve the application's original body,
that no intermediate SEO screen appears, and that `#root` is never hidden by SEO.
Assert a single title/canonical/robots/description after readiness, no transient
home pathname on deep-link loads, and removal of stale metadata after navigation,
and that a profile renders one `<h1>` and anchors to its posts
(`packages/e2e/tests/seo-handoff.spec.ts`).

## Eligibility

- Profiles must resolve through Oxy's public profile endpoint and have public
  Mention profile visibility.
- An account can opt out of search engines (Settings → Privacy → "Show in
  search engines", `privacy.searchEngineIndexing`). Its profile and posts stay
  public to people — the pages render and unfurl as before — but are served
  `noindex,follow` and are left out of the sitemap. A boost of an opted-out
  author's post is `noindex` too: its words are theirs. Federated accounts have
  no Mention settings and are indexed unless private.
- Posts must be published, public, safe for discovery, and authored by a public
  profile.
- Sensitive posts may still produce privacy-safe link previews, but are marked
  `noindex,nofollow` and never expose their body or image in the initial HTML.
- Missing public entities return `404`; dependency outages return `503` with
  `Retry-After`, preventing soft-404 indexing.

## Discovery and operations

`/robots.txt` advertises `/sitemap.xml`. The sitemap index links to bounded
profile and post shards under `/sitemaps/`. Rows are assigned to one of 64 stable
hash buckets, so a newly published post changes one shard rather than shifting
every later offset page. A shard contains at most 40,000 URLs, safely below the
protocol's 50,000 URL limit. Profile entries are derived from authors with
eligible Mention posts, then resolved in bounded batches through Oxy's public
bulk-profile gate, which excludes archived and restricted accounts.

Sitemaps are built in ONE pass, off the request path, by `SitemapBuildJob` on
the scheduler leader whenever the cached catalog is six hours old: one grouped
read for every profile shard and one bucket-ordered, streamed read for every post
shard, then the catalog. Requests only read that cache. A shard the catalog does
not list is `404`; an empty cache (a fresh deployment, a flushed Redis) is `503`
with `Retry-After` until the first build lands. Building each shard on demand
cost a full read of the eligible posts per shard (~30 s for a profile shard) and
a crawler walking the index made that ~70% of Mention's database load (#1160).
Responses carry `Last-Modified` (the build time) and an ETag, so a revalidating
crawler gets a `304`, and may be cached for an hour (six at the CDN).

Submit only the root sitemap in Google Search Console and monitor Page Indexing,
ProfilePage markup, crawl failures, and sitemap URL counts. Retired numeric shard
URLs return XML with `410 Gone`, never the HTML application shell.

The production smoke test is `https://mention.earth/@aida_quilcue@x.com`: it must
return a `200`, a self-canonical URL (`/@aida_quilcue@x.com`), and valid
`ProfilePage` JSON-LD to both a
normal browser user agent and Googlebot. Visible identity text comes from the
application after it loads.
