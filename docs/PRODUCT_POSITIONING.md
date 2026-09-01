# Product positioning

**Status:** canonical. This is the source of truth for what Mention is, for
product copy, app-store listings, package descriptions and generated text.

## What Mention is

Mention is a consumer-facing **social network**: people create accounts,
write and read posts, follow each other, and see a feed. It ships for iOS,
Android and the web from one codebase, and it federates with the wider
Fediverse over ActivityPub (and reads from AT Protocol) so a Mention account
can be followed from, and can follow, accounts on other networks — see
[Fediverse](./fediverse.mdx).

## What Mention is not

Mention is not a **social-listening or social-media-management** product. It
does not monitor, analyze, schedule posts to, or manage accounts on
third-party social networks on a customer's behalf. Connecting to
ActivityPub or AT Protocol makes a Mention account reachable from those
networks and lets it read from them — it does not turn Mention into a
dashboard for operating someone else's Twitter, Instagram or Mastodon
presence. That category of product exists and Mention is not it.

This matters for reasons beyond marketing accuracy: a third party holds a
US trademark on "Mention" in the social-listening / social-media-management
space. This document does not take a position on that trademark's validity
or scope — that is a legal question, not a product one — but Mention's own
copy should describe what the product actually does, which was never that
category, rather than accidentally drifting into language that invites the
comparison.

## Rules for product copy

- Describe Mention as a social network / social networking platform, or
  describe a specific first-party feature (feeds, federation, channels,
  moderation) directly. Do not describe it as a tool for monitoring,
  tracking, listening to, or managing OTHER social networks or brands.
- Federation copy stays precise: "connects to the Fediverse" / "federates
  over ActivityPub", not "manages your social media" or "monitors your
  mentions across platforms."
- Do not rename the product or add a prefix/suffix (no "Oxy Mention").
- Do not claim trademark clearance, ownership, or non-infringement in
  product copy — that is a legal determination, not something a README or
  an app-store listing gets to assert.
- Do not call the Breathe-licensed codebase "open source" — see the
  [README's License section](../README.md#license) for the accurate terms.

## Where this applies

App store listings, `package.json` `description` fields, the root and
per-package `README.md` files, onboarding/marketing copy in the frontend,
and anything else that describes what Mention is to a reader who has not
used it yet. None of the current first-party copy in this repository was
found to violate this (audited for issue #704: `README.md`, every workspace
`package.json`, `app.config.js`, and `docs/`) — this document exists so
future copy has one place to check against, not because anything needed
fixing.
