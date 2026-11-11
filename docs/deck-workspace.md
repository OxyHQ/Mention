# Deck workspace and Bloom layout ownership

Deck is a desktop web workspace made from the same routed screens used by the
main application. Bloom owns the layout, header/footer composition, responsive
panel geometry, scrollbars and panel histories. Mention owns screen data,
authentication, workspace storage and synchronization policy. Read Bloom's
[Compose application layouts](https://github.com/OxyHQ/Bloom/blob/main/docs/compose-layouts.mdx)
guide alongside [Frontend rules](./frontend-rules.md).

## Rendering contract

The application keeps one AppShell and changes its declarative `panelLayout`.
Normal screens use document flow; Deck uses bounded columns with horizontal
scroll on the document and independent vertical scroll in each column. Vertical
and trailing gutters, sidebar overlap material, size constraints and transitions
belong to Bloom. Restored `activePanel` is passive: loading Deck does not scroll
horizontally to the last selected column. Adding a column issues Bloom's transient
`revealPanel` request so the new column comes into view. This request is excluded
from local/account workspace snapshots and cleared on account activation.
Bloom waits for the compositor's own transitions before revealing the expanded
column; content animations do not delay it. A superseded request or unmounted
layout cancels the pending reveal. Reduced motion keeps the same destination
without animated scrolling.
Do not reimplement these with window measurements or nested
application scroll containers.

Bloom's compact sidebar mode switch (`modesPresentation="toggle"`) changes composition without navigating: the current
Expo page stays mounted in the same `main` panel and is always the first column.
This application column cannot be removed, resized or assigned a different feed;
ordinary app navigation changes the page it shows. Additional columns retain their
own configurable feeds and histories. An untouched legacy leading Explore slot
is replaced by this application column; any customized legacy column is retained
as an additional column, with its settings and history intact.

Additional columns opt into Bloom's `reorderable` header grip. Bloom owns pointer
and keyboard movement and reports `onPanelOrderChange`; Mention persists only
the saved-column order through the existing account cache/sync. The main column
stays fixed. Reordering preserves panel IDs, navigation, scroll snapshots and
hidden legacy slots.

Bloom owns panel movement and document/column scroll handoff through its default
simultaneous transition. The main route and navigation remain visible while
outgoing and incoming columns change alongside the retained layout. Both
directions preserve the reading viewport and content throughout the movement;
reduced-motion behavior also belongs to Bloom.
Panel invitations use the descriptor's
`bottomBar` slot; the route Screen composes and measures that footer without an
application wrapper. The selected mode is stored locally per account, separately
from synchronized column configuration. Phones retain normal layout; returning
to desktop restores the selected mode.

Each route renders `Screen scroll="auto"`, with its `PageHeader` in `header` and
optional `PageFooter` in `bottomBar`. Header material follows that Screen's owner.
Descriptor `headerActions` adds the column-settings control to the same header;
Bloom adds Back only when history permits. Profiles, topics, saved feeds and posts
render their actual route components inside `PanelRouteSlot`. Links and hooks use
Mention's panel-aware router adapter, not the global Expo router singleton.

Deck's Metro context uses `lazy` mode to retain production route code splitting.
Building the registry does not import every screen into the startup bundle. A
panel's first module load uses its Bloom skeleton; resolved modules and component
identities are shared across columns and revisits. A rejected chunk reaches a
Bloom PanelErrorBoundary in that column. Its retry action resets only failed
module records and retries the fetch, preserving healthy panels and navigation.
Do not replace this with a synchronous context or a `Promise.resolve` wrapper
around eagerly bundled screens.

Settings pages use Bloom's SettingsModal and Screen composition, including the
shared scrollbar. Full-bleed settings routes compose the modal's Back/close
controls into their existing screen header. Overlay scopes isolate navigation,
scroll metrics and restoration from the page underneath. Do not add a second
header, component-specific scrollbar CSS or a ScrollView around an existing owner.

## What survives reload

The workspace contains panel order, active panel, source and presentation
preferences, live-update policy, each panel's navigation entries and selected
index, and Bloom scroll snapshots. It stores references and UI state, not fetched
posts, profile responses, tokens or media. Entry keys remain stable across reload.
Bloom snapshot keys are opaque URI-encoded strings and must be stored unchanged.

`deckSettings` keeps an immediate account-scoped cache under
`mention:deck:workspace`. Records contain the current state, last acknowledged
base, server revision and pending-change marker. Anonymous use has its own local
record. Switching accounts changes the record and fences old asynchronous writes;
it must never upload one account's workspace into another account.

History is controlled through Bloom's `navigation.state` and
`onNavigationChange`. `navigation.scrollRestoration` seeds offsets and reports
settled snapshots. Its `scopeKey` replaces the panel scope when restoring an
account/workspace, without remounting the application shell. Bloom handles delayed
web content restoration and stops retrying when the user takes over scrolling.
The application's data cache can display known content immediately; cold reads
still require skeletons and may fail or take time.

## Deck as the home screen

On desktop, **Settings → Deck → Make Deck my home screen** opens the Deck
composition when visiting `/`, including the Home and Mention-logo links.
Home remains the fixed first column, with configured columns beside it. A cold
`/deck` link activates Deck mode and resolves to Home. Mode switches preserve the
current route; navigation continues inside the fixed application column.
Explicit deep links remain unchanged, and Home rendered inside a Deck panel stays
the regular feed. Phones and tablets retain normal Home even when this account
preference is enabled; the switch appears only where Deck is available.

The optional `homeScreen` workspace field defaults to false for existing accounts.
It uses the same account-scoped local cache and synchronization policy as panels:
with sync enabled it follows the account across devices, and with sync disabled
changes remain local until sync is enabled again. Account activation is checked
before applying the preference. Cached choices take effect immediately; on a new
device Home can remain visible until the server workspace arrives. Offline reads
never block opening the app.

## Account synchronization

The Deck section in Mention settings (`/settings/deck`) exposes **Sync across
devices** and synchronization status, with automatic retries after failures.
With synchronization enabled, authenticated
clients load and save the account workspace through `GET /deck` and `PUT /deck`.
A new device loads the account snapshot; local cached state remains available
while reads or writes are pending. This is revisioned persistence, not a live
socket broadcast of every scroll movement to other devices.

`startDeckSync` serializes writes per viewer. A save sends its last acknowledged
`baseRevision`. HTTP 409 returns the current server document; the client performs
a three-way reconciliation using its acknowledged base, pending local edits and
remote state, then retries. Independent field/panel changes can survive concurrent
writes. This is not collaborative editing of screen content. Failed requests keep
local edits pending, retry with bounded backoff, and retry on reconnect. Do not
show an unsaved change as acknowledged by the server.

Disabling sync persists the account preference while preserving the server's
previous layout. Further navigation stays on that device; it is not uploaded as
part of disabling. Re-enabling sends the device's current workspace using the
revision/conflict protocol. Signed-out use stays local. An offline preference
change cannot reach another device until the server acknowledges it.

## Backend and rollout

The contract lives at `@mention/shared-types/deck`. The session supplies account
ownership; clients cannot select another owner's record. The endpoints return
`Cache-Control: private, no-store`. A missing record is
`{ revision: 0, state: null }`, allowing the frontend to choose current defaults.
The dedicated PostgreSQL workspace document uses atomic compare-and-swap; it is
not a Redis-only cache. Account erasure deletes it.

Validation limits the document to 24 panels, 100 history entries and 256 offsets
per panel, with a 512 KiB body limit. Internal route validation and finite numeric
bounds prevent an arbitrary external URL or malformed snapshot from becoming a
restored screen. See the [private Deck API](./api.mdx#private-deck-workspace) for
wire semantics and [account erasure](./account-erasure.md) for deletion ownership.

Migration `0079_deck_workspaces` must run before the backend image serving these
endpoints. Shipping a new Bloom package or frontend alone does not deploy this
schema/API. Until the backend rollout is complete, local persistence can work
while account synchronization reports a failure. Record deployment verification
separately from local tests; documentation of the feature is not evidence that
production already runs it.

## Verification checklist

- Reload a panel on a nested profile/topic/post route and verify history, Back,
  independent offsets and delayed-data restoration.
- Open a fresh browser context for the same account and verify the acknowledged
  workspace, without copying browser storage.
- Exercise concurrent revisions, offline edits, retry, sync disable/enable and
  account switching; no stale response may overwrite a newer viewer.
- Verify authenticated ownership, first-insert/update conflicts, invalid payloads,
  disabled-layout preservation and account erasure against PostgreSQL.
- Check normal document pages, Deck horizontal scrolling, compact settings and
  native list ownership; headers and indicators must follow the correct owner.
- Enter and leave Deck repeatedly from a scrolled post; the main panel must keep
  its full reading viewport, visible reply content, navigation and reading
  position throughout each transition, not just after it finishes.
- Open a supporting split in normal and Deck modes; the main viewport must
  shrink progressively without collapsing below its final share or briefly
  displaying the beginning of the post.
- Reorder additional columns by pointer and keyboard, preserving their DOM,
  history and horizontal offset. The first application column stays fixed.
- Add a column from the trailing action, verify that its final box is revealed,
  then remove it through its settings.

Browser geometry assertions and raw pointer coordinates must wait for the
configured column widths to settle. Visibility alone does not mean that an
entrance transition has finished. The release gate uses `expectDeckColumnWidths`
for these checks rather than fixed sleeps or relaxed geometry tolerances.

Browser fixtures may mock the HTTP contract; PostgreSQL tests separately establish
server behavior. Neither proves that production has been deployed.

## Supporting post panels

Opening a post's likes, reposts or Insights splits only the originating panel
vertically. The direct Insights button is offered only on an owned focused post
detail (including a Deck route), not feed cards or nested replies; the existing
permission-gated overflow menu shares the same host dispatch. The
post and engagement list share the available height equally; each uses its own
real Bloom scroll owner. Mention exposes no resize handles, including on saved
Deck columns. Their authored sizing and responsive bounds remain active. The main pane
has a useful minimum of 224px normally, or 368px when the host includes
the anonymous sign-in footer; the auxiliary pane has its own 128px minimum for
its header and a readable row. These authored bounds leave room for screen chrome
and readable content. If the window cannot fit those minimums and the gap, Bloom
presents the engagement list as a sheet instead of crushing either pane. Closing the
list restores the post's available space. A narrow viewport presents the same
engagement screen as a bottom sheet instead of an inline split.

The main application group uses Bloom's `singlePanelFlow: 'document'`: ordinary
web routes retain document scrolling while the supporting panel is closed or
floating because of the narrow-width policy. An inline split becomes bounded without
replacing the route tree. A height-constrained sheet retains the bounded main
while open so its capacity query cannot oscillate with document height; closing
it restores normal document flow. When closing an inline split, Bloom retains the
bounded scroll owner until its own and enclosing layout geometry transitions
finish, then transfers the current reading offset to the document in the same handoff.
Deck groups stay bounded throughout. Group and routed leaf IDs retain the
existing workspace IDs in their separate sibling scopes, preserving saved
navigation and scroll snapshot keys. Bloom owns responsive eligibility,
geometry, animation and scroll-owner transfer; Mention measures none
of these.

One lightweight provider captures each main or Deck host's route and navigation;
supporting-panel dispatch adds no per-row authentication or store subscriptions.
Destinations are transient and separate for each column. Closing or leaving a
route keeps its inactive content only until Bloom's `onExitComplete` callback,
then releases the destination and navigation closure. Completion must still match
the viewer generation, destination identity and closed state; reopening or a new
destination cancels an earlier completion. Changing account, removing a host or
unmounting the shell clears its destinations immediately. Clicking an engager closes
the list and navigates in the originating column's history. The list keeps its
virtualization, localized loading/error/empty states and cursor pagination in
both presentations. Insights reuses the existing viewer-scoped queries and a
single Bloom Screen/ScreenScrollView, including its standalone sheet fallback.
Retained exit content follows Bloom's actual lifecycle, never an application timer,
a second active list or a render-time ref in the shell.

## Video replies and immersive presentation

Videos uses the same host-owned compositor with a horizontal group: the main
route has an authored 978px budget for its 620px video and 350px replies plus the
shared gap. This horizontal shape and an empty replies Screen are declared from
the host's active route before feed data arrives, including parameterized Deck
video routes, so the video never first occupies the replies column. The current
video's replies are available inline automatically.
Narrow windows and narrow Deck columns use Bloom's capacity policy to present
one floating replies screen, opened by the reply action. Dismissing that sheet
clears floating intent while keeping automatic inline availability; changing the
active video, losing the active item, leaving the route or switching viewer
releases the previous owner. RightBar no longer owns a second replies renderer.

The transient destination owns draft text, edit revision and any pending send.
Changing inline/sheet presentation can remount the composer without losing those
data or permitting duplicate submission. A route close followed by an immediate
return creates a new owner, so an earlier completion cannot clear its draft.
Viewer and session epoch fences remain in force. Typing subscribes only the
composer, not the shell layout. Video keys, decoder ownership and pager state
remain separate from the supporting panel; opening replies applies no video
translation, scale or viewport-height calculation in Mention.

The floating header uses plain For You/Following tabs and real followed-account
avatars. Following and write actions retain their session gates. The immersive
route keeps Mention navigation for anonymous readers instead of reserving a
large sign-in footer. Content consumes Bloom's remaining bottom inset once.
FollowButton stays the shared component without custom styles. Video engagement
uses PostActions' vertical presentation with the same Bloom activation and count
animations. Save remains visible in that rail; external Share is in its overflow menu.

Post details and video replies share `CompactReplyComposer`: a Bloom Surface
capsule with one persistent Textarea. At rest Media, GIF and Maximize form one
trailing group of adjacent 32px controls, with no additional gap on top of their
existing hit-area padding. Match that grouping in the expanded toolbar instead
of widening controls or spacing to imitate a screenshot. Focus, text, attachments or an in-flight publication keep the
expanded toolbar visible. Text and attachments use one bounded Bloom ScrollArea;
the Textarea grows without its own scrolling, and a sibling Bloom Toolbar keeps
Media/GIF, the character ring and Reply fixed below that viewport.

Compact replies accept at most 250 UTF-16 code units, matching the existing
Compose/backend counting convention. Rejected edits cue Maximize through Bloom's
GlyphButton attention feedback. Existing longer drafts remain intact and can be
shortened or expanded, but cannot publish inline. The shared MeterRing uses 250
here and the full composer's existing 25,000-character limit there, including the
empty state. Media-only replies are valid. Image and GIF pickers reuse the existing
private asset pipeline and preserve uploaded IDs, media types, order and alt text.

Maximizing transfers the exact text, attachments and reply target through a
viewer/session-scoped, one-shot token, without changing public compose intent
parsing or uploading media again. Compose persists that incoming snapshot before
acknowledging ownership. The source keeps its draft until acknowledgement, and a
synchronous transfer lease prevents duplicate maximize/send actions while
navigation commits. Committed route removal flushes subsequent edits through the
existing draft manager, so Back before the autosave debounce cannot discard them;
no extra gesture recognizer or navigation blocker is installed.

`PostReplyFooter` uses Bloom's contextual TabPagerBottomBar dock with an 8px
horizontal inset. The normal main post route owns compact navigation declaratively,
including its loading and unavailable states; the global bar is suppressed for
that same host. The editor stays mounted through dock, focus and Deck changes.
Video reply sheets and secondary Deck hosts keep the compact editor without a
second navigation bar. Historical Media/GIF and post-action glyphs come from
Bloom; existing Button and EngagementAction behavior remains shared.

The video reply counter reads the shared post cache for the active item, so inline
and full-composer publication cannot diverge or double-increment it. Manual video
pause belongs to its viewing interval; pending tap timers are cancelled on
inactivation or focus loss before another video takes playback authority.

Bloom 19.6 published the nested panel groups, exit lifecycle, vertical engagement
presentation and linear scrim support. The subsequent composer work requires the
[Bloom 19.7 (PR #798)](https://github.com/OxyHQ/Bloom/pull/798) release containing contextual dock navigation, dynamic action sizing,
historical glyphs and GlyphButton attention feedback. Publish that shared release
through CI before updating Mention's catalog and lockfile. A local built-package
snapshot validates the integration but does not establish published adoption.
