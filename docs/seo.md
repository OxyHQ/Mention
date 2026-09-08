# Public search indexing

Mention serves public profiles and posts from the apex as semantic HTML before
the Expo application becomes interactive. Browser and crawler requests receive
the same initial document. The backend owns the initial title, description,
canonical URL, robots directive, Open Graph fields, JSON-LD, and visible fallback
content; the frontend `SEO` component keeps those fields current after client-side
navigation.

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
eligible Mention posts, then rechecked through Oxy's public profile gate.
Matching partial expression indexes let PostgreSQL seek directly into a bucket,
so shard generation grows with the shard rather than with the full archive.

The catalog, gzip-compressed generated XML, and Oxy public-profile decisions use
the web-shell SWR cache. Oxy requests are bounded in batches and concurrency, and
a dependency failure aborts generation instead of caching an incomplete shard.
This keeps repeated crawler reads off PostgreSQL and Oxy while still refreshing
changed shards without allowing large XML strings to dominate Redis memory.
Submit only the root sitemap in Google Search Console and monitor Page Indexing,
ProfilePage markup, crawl failures, and sitemap URL counts. Retired numeric shard
URLs return XML with `410 Gone`, never the HTML application shell.

The production smoke test is `https://mention.earth/@aida_quilcue@x.com`: it must
return a `200`, a self-canonical URL, visible “Aida Quilcué” identity text, and
valid `ProfilePage` JSON-LD to both a normal browser user agent and Googlebot.
