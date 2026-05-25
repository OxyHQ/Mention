# Mention Compose Intent URL

Third-party sites and apps can deep-link into the Mention composer with
prefilled content — like X / Twitter `intent/tweet?text=`. Works on web, iOS,
and Android.

## Canonical URL

```
https://mention.earth/intent/compose?text=...&url=...&hashtags=foo,bar
```

The legacy alias `https://mention.earth/compose?...` accepts the same query
parameters.

## "Share with Mention" button

Drop this anywhere on your site to give users a one-click composer link:

```html
<a
  href="https://mention.earth/intent/compose?text=Check%20this%20out&url=https%3A%2F%2Fexample.com&via=mention"
  target="_blank"
  rel="noopener noreferrer"
>
  Share with Mention
</a>
```

Always URL-encode parameter values (`encodeURIComponent` in JS).

## OS share sheet

- **Android / Chrome (PWA installed)**: Mention appears in the system share
  sheet automatically via Web Share Target. Title, text, and URL forward to
  the composer.
- **iOS / Android (native app installed)**: Mention appears in the OS share
  sheet through `expo-share-intent`. Shared text and URLs route to the same
  intent endpoint.
- Image / video share is **not yet supported** in this release.

## Supported parameters

All parameters are optional. Unknown keys are silently dropped (logged in dev
builds). Invalid values are dropped without breaking the rest of the intent.

| Param | Type | Notes |
|---|---|---|
| `text` | string | Trimmed, HTML stripped, clamped to 500 chars after assembly. |
| `url` | string | http/https only. Appended to text with a leading space. |
| `hashtags` | string | Comma-separated. Lowercased, deduped. Max 10. |
| `via` | string | Handle to credit. Leading `@` stripped. Renders as ` via @handle`. |
| `mentions` | string | Comma-separated handles. Deduped. Max 10. |
| `replyToPostId` | string | Open composer in reply mode for this post. |
| `quotePostId` | string | Open composer with quote card. If unreachable, the share URL is appended to the text instead. |
| `editPostId` | string | Open composer in edit mode for this post. |
| `pollOptions` | string | Pipe-separated (`|`). 2–4 options. Empty entries dropped. Opens the poll creator. |
| `pollDurationDays` | number | 1–7. Defaults to 7. |
| `articleTitle` | string | Opens the long-form article editor. |
| `articleBody` | string | Article body content. |
| `eventName` | string | Opens the event editor. |
| `eventDate` | string | ISO-8601 date (`YYYY-MM-DD` or full timestamp). |
| `eventLocation` | string | Event location label. |
| `eventDescription` | string | Event description. |
| `lat` | number | Latitude, -90 to 90. |
| `lng` | number | Longitude, -180 to 180. |
| `address` | string | Display address. Only applied with valid `lat`+`lng`. |
| `sources` | string | Comma-separated URLs. http/https only. Max 5. |
| `scheduledFor` | string | ISO-8601 future timestamp. Opens schedule sheet. |
| `sensitive` | `1`/`true` | Marks the post as sensitive content. |
| `replyPermission` | `anyone` / `following` | Restricts who can reply. |
| `quotesDisabled` | `1`/`true` | Disables quoting. |
| `lang` | string | BCP-47 language tag (e.g. `en`, `es-MX`). |

## Examples

### Tweet-style share

```
https://mention.earth/intent/compose?text=Check%20out%20this%20podcast&url=https%3A%2F%2Fpodcast.example.com%2Fep42&hashtags=podcasts,tech&via=podcasts
```

Composes:

```
Check out this podcast https://podcast.example.com/ep42 #podcasts #tech via @podcasts
```

### Pre-filled poll

```
https://mention.earth/intent/compose?text=What%27s%20your%20favorite%20editor%3F&pollOptions=Vim%7CEmacs%7CVSCode%7CHelix&pollDurationDays=3
```

Opens the poll creator with four options and a 3-day duration.

### Quote prefill

```
https://mention.earth/intent/compose?quotePostId=abc123&text=My%20take
```

Composer renders a quote card for `abc123` (or appends the share URL if the
post is missing/private).

### Event prefill

```
https://mention.earth/intent/compose?eventName=Meetup&eventDate=2026-06-15T18%3A00%3A00Z&eventLocation=Barcelona
```

## Behavior notes

- **Draft conflict**: if a saved draft exists when an intent URL opens, the
  composer prompts the user to keep the draft or replace it with the shared
  content.
- **Text clamping**: assembled text (mentions + text + url + hashtags + via)
  is clamped to 500 characters; the last token is replaced with `…` if
  needed.
- **Security**: URL params are validated (`new URL()` + http/https), HTML
  tags are stripped from text fields, and unknown params are ignored.
  `javascript:` and other non-http schemes are rejected.
- **Mentions**: handles arrive as literal `@handle` tokens in the text.
  When the user interacts with the composer, the mention picker resolves
  them to user IDs.
- **`lang` and `pollDurationDays`** are parsed and validated but the
  composer UI doesn't yet expose them as editable fields; they're
  forward-compat for when those controls land.

## Out of scope (Phase 2)

- `mediaUrl=` (remote media fetch + attach)
- `thread[0].text=` (multi-post thread prefill)
- POST-based Web Share Target (file uploads)
- Server-side intent shortlinks (e.g. `mention.earth/intent/{shortcode}`)
