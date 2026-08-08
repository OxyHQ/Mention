# User mentions

User mentions link text in a post to an Oxy identity. They are unrelated to
MTN, Mention's signed-record protocol.

## Canonical forms

| Stage | Form |
| --- | --- |
| Composer display | `@handle` |
| Stored post text | `[mention:<oxyUserId>]` |
| Stored index/allowlist | `Post.mentions: string[]` |
| Hydrated API text | `[@<label>](<canonicalHandle>)` |
| Rendered post | Clickable `<label>` linking to `/@<canonicalHandle>` |

For example, selecting `@alice` can produce:

```json
{
  "content": { "text": "Hello [mention:oxy-alice]" },
  "mentions": ["oxy-alice"]
}
```

The placeholder is an internal stable reference. A bare `@alice` typed without
selecting a result is ordinary text: it does not populate `Post.mentions` and is
not treated as a canonical mention.

## Composer and picker

`packages/frontend/components/MentionTextInput.tsx` owns the input
transformation, but not mention state. Its parent passes controlled
storage-format `value` + `mentions` and receives one atomic
`onValueChange({ text, mentions })` candidate update. The parent reconciles that
registry against every author rendition of the same post. This avoids a hidden
child registry drifting from compose, threads, variants, drafts, or edit mode.
When the cursor is inside an `@` token without a space or newline, it opens
`MentionPicker`.

`packages/frontend/components/MentionPicker.tsx` waits 300 ms after at least one
query character, then calls Oxy `searchProfiles` with a limit of ten. Selecting
a valid profile records:

```ts
{
  userId: string;
  username: string;
  displayName: string;
}
```

and replaces the active token with `[mention:<userId>]` in parent state.
Compose, thread items, and content variants use this component. Shared helpers
in `@mention/shared-types/mentions` and
`packages/frontend/utils/mentions.ts` preserve body order, deduplicate IDs and
intersect metadata with placeholders that are still present. A placeholder
typed by hand never authorizes a recipient.

The text and ID array are one invariant:

- Every canonical placeholder must have its ID in `mentions`.
- `mentions` contains Oxy user IDs, not usernames or display names.
- Callers send both forms together; the server never infers IDs from arbitrary
  text.
- Every create/thread/edit boundary intersects the supplied allowlist with the
  placeholders in all author variants before persistence and notifications.

The frontend performs the same reconciliation when typing, changing languages,
saving/restoring a draft, and building a request. Backend reconciliation is the
final authority, so an old or malicious client cannot notify an ID whose
placeholder is gone.

Edit mode must not reverse a hydrated Markdown link back into an identity.
`GET /posts/:id/edit-source` is owner-only and returns the raw author variants,
the exact ID allowlist, and any canonical Oxy users that resolved for display.
If Oxy is unavailable, the stable placeholder and ID are preserved with no
invented handle.

## Persistence and hydration

`Post.content` stores the placeholder text and `Post.mentions` stores the
identity references used by queries and readers. Readers normalize and
deduplicate this array. `mentions` is indexed together with `created_at`.

All post DTOs go through `PostHydrationService`. For each post it:

1. Treats the post's normalized `mentions` array as the allowlist.
2. Resolves only allowlisted IDs that appear in the text, using the shared
   per-request user cache and bulk Oxy resolution.
3. Uses `getNormalizedUserHandle`, including `username@domain` for federated
   users.
4. Replaces a resolved placeholder with
   `[@<displayName-or-handle>](<canonicalHandle>)`.
5. Applies the same resolution to the selected body and every inline language
   variant.

An undeclared or unresolved placeholder is not linked and is left unchanged
rather than inventing an identity. Consumers must render hydrated DTOs, not raw
post rows.

`packages/frontend/components/common/LinkifiedText.tsx` recognizes the hydrated
form, renders its label with link styling, normalizes the handle, and navigates
to `/@<handle>`. It does not turn arbitrary plain `@text` into a profile link.

## Notifications

Mention notifications are driven by the persisted `mentions` IDs, not by
parsing visible text. Published posts run `createMentionNotifications` from the
post side-effect pipeline; scheduled posts do so when they are published, and
thread creation applies it per post.

The helper deduplicates recipients and skips self-mentions. `createNotification`
also prevents duplicate records for the same recipient, actor, type, and
entity. A successful notification is stored, emitted on the Socket.IO
`/notifications` namespace to `user:<oxyUserId>`, and offered to push delivery
on a best-effort basis. The entity type distinguishes a post mention from a
reply mention.

## ActivityPub

Inbound and outbound federation preserve the same storage invariant.

For an inbound Note:

1. The ActivityPub `tag` entry with `type: "Mention"` supplies the authoritative
   actor URI.
2. Its matching content anchor is identified by `href`, not ambiguous visible
   text.
3. Resolved local or remote actors are mapped to canonical Oxy user IDs.
4. Matching anchors in `content` and `contentMap` become internal placeholders,
   and the IDs are stored in `Post.mentions`.
5. Unresolved anchors remain ordinary text.

Only locally hosted mentioned users receive a Mention notification for an
inbound federated post, and each recipient's fediverse-sharing consent is
checked. Remote identities remain in `Post.mentions` for rendering but do not
have a local Mention notification inbox.

For outbound Notes, the ActivityPub connector batch-resolves the IDs declared
by `Post.mentions`. A resolved placeholder becomes a safe
`<a class="u-url mention">` anchor and a machine-readable `Mention` tag. Remote
mentioned actors are added to addressing and delivery inboxes where available.
Undeclared or unresolved internal placeholders are removed from federated HTML;
raw Oxy IDs never go onto the wire.

## Maintainer checklist

- Use `MentionTextInput` rather than implementing another parser.
- Keep its text and metadata controlled by the post-level composer state.
- Reconcile against all author variants, not only the currently visible tab.
- Hydrate through `PostHydrationService`.
- Use canonical Oxy handles for navigation.
- Preserve href-based ActivityPub matching and never expose internal
  placeholders externally.
