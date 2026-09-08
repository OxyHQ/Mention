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
profile and post pages under `/sitemaps/`; profile entries are derived from
authors with eligible Mention posts, then rechecked through Oxy's public profile
gate. Submit the root sitemap in Google Search Console after deployment and
monitor Page Indexing, ProfilePage markup, crawl failures, and sitemap URL counts.

The production smoke test is `https://mention.earth/@aida_quilcue@x.com`: it must
return a `200`, a self-canonical URL, visible “Aida Quilcué” identity text, and
valid `ProfilePage` JSON-LD to both a normal browser user agent and Googlebot.
