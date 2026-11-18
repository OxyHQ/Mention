# The protected feed profile

Oxy derives protective defaults from an account's age band (`protectionsFor`,
oxy ADR 0068): for a minor, a feed in the order it was posted and loaded on
request, no autoplay, and quiet hours from 22:00 to 07:00 on the account's own
timezone. An adult, and an account of unknown age, get the standard profile.
Mention holds no age: it reads the band on the session Oxy validated and
derives the rest.

## What the server enforces

- **No ranked feed.** `resolveDefinition` serves a `protected` viewer nothing
  whose definition is `mode: 'ranked'`. The home feed and Following both become
  the chronological Following timeline; every other ranked feed (Explore,
  Trending, Videos, a ranked custom feed) is refused with `403
  FEED_WITHHELD_FOR_PROFILE`. The rule reads the resolved definition, so a
  ranked feed added later is withheld without being listed anywhere.
- **No push at night.** `loadPushTargets` asks Oxy which recipients are in
  their quiet hours and leaves them out. The notification is written either
  way; only the push waits. If Oxy cannot answer, nobody is held: failing the
  other way would silence every push to everyone.

The band reaches the feed endpoint on the user Oxy's safety session returns,
which is why the reviewed supervised mounts keep that user (`loadUser`).

## What the client offers

`useAgeProtections()` reads the band from the signed-in account's own profile.

- The ranked presets are not offered as tabs or on the feeds screen
  (`savedFeedsOfferedTo`, from `PRESET_FEEDS[].ranked`), so the home screen
  opens on Following. A test holds that flag equal to the server's definitions.
- Reaching the end of the list does not fetch the next page; the footer offers
  **Load more**.
- Video and animated media do not autoplay (`VideoPlaybackProvider autoplay={false}`).

Edits to the saved layout are computed from the whole stored layout, not from
what is offered, so pinning a feed never drops the presets a protected viewer
is not shown.

## For everyone

A home timeline read to its end says "You're all caught up" instead of just
stopping.

## Limits

- The band comes from a self-declared date of birth, and only accounts that
  have one have a band. An existing account with no date gets the standard
  profile.
- There is no daily time limit: nothing measures time in the app.
- Guardian-set limits for a supervised account are not built.
