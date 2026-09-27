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

## Verification

Use a production web export and the real backend renderer. Verify that JavaScript-
disabled and delayed-script responses preserve the application's original body,
that no intermediate SEO screen appears, and that `#root` is never hidden by SEO.
Assert a single title/canonical/robots/description after readiness, no transient
home pathname on deep-link loads, and removal of stale metadata after navigation.

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
return a `200`, a self-canonical URL, and valid `ProfilePage` JSON-LD to both a
normal browser user agent and Googlebot. Visible identity text comes from the
application after it loads.
