# Public search indexing

Mention serves public profiles and posts from the apex as semantic HTML before
the Expo application becomes interactive. Browser and crawler requests receive
the same initial document. The backend owns the initial title, description,
canonical URL, robots directive, Open Graph fields, JSON-LD, and visible fallback
content; the frontend `SEO` component keeps those fields current after client-side
navigation.

## Server-to-client handoff

The renderer marks its title, meta, canonical and JSON-LD elements with
`data-mention-seo="true"`. Eligible public content appears in a separate
`<main data-mention-seo-fallback="true">` outside Expo's `#root`, with the
canonical URL in `data-mention-seo-url`. User text is escaped; no public body is
emitted for restricted, missing, failed or warning-gated responses. Boosts must
also pass current visibility and author checks for their original post before
a cached representation can be served.

The frontend stylesheet keeps that document visible while the matching React
route loads underneath. Only the route's ready state releases the fallback;
mounting providers or resolving authentication alone is insufficient. Real
navigation to another pathname releases stale server content and metadata,
including navigation to a route without an SEO component.

Initial post metadata remains authoritative because the backend evaluates raw
safety and visibility signals that the hydrated client DTO does not contain.
When navigating client-side to a post without that server proof, use generic
`noindex,nofollow` metadata without body text, content-derived images or structured data. A direct
request for the same eligible public URL still receives indexable server HTML.
Do not infer public eligibility from the DTO's `metadata.isSensitive` alone.

## Rollout and verification

The frontend export advertises `<meta name="mention-seo-handoff" content="1">`.
The backend adds semantic fallback content only when that capability is present
in the fetched shell. Cached legacy shells keep their existing empty SPA body,
so parallel frontend/backend rollout and rollback are safe. Frontend-first
rollout remains preferred; verify the marker survives the exported document.
The backend's minimal no-JavaScript emergency shell also advertises support,
because it has no client tree that could duplicate the visible content.

Use a production web export and real renderer output to check JavaScript-disabled
public content, initial boot, delayed profile/post reads, and client navigation.
Assert a single title/canonical/robots/description, fallback removal only when
matching content is ready, no transient home pathname on a deep-link load, and
no private or sensitive text in response HTML. Backend tests also cover current
boost-original eligibility and bypassing cached public text after a warning
flag changes. Missing entities and dependency failures retain 404 and 503.

## Eligibility

- Profiles must resolve through Oxy's public profile endpoint and have public
  Mention profile visibility.
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
return a `200`, a self-canonical URL, visible “Aida Quilcué” identity text, and
valid `ProfilePage` JSON-LD to both a normal browser user agent and Googlebot.
