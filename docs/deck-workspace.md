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
and trailing gutters, sidebar overlap material, resize constraints and transitions
belong to Bloom. Restored `activePanel` is passive: loading Deck does not scroll
horizontally to the last selected column. Adding a column issues Bloom's transient
`revealPanel` request so the new column comes into view. This request is excluded
from local/account workspace snapshots and cleared on account activation.
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

Bloom owns panel movement and document/column scroll handoff through
`panelLayout.transition="exit-before-enter"`. Panel invitations use the descriptor's
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

Browser fixtures may mock the HTTP contract; PostgreSQL tests separately establish
server behavior. Neither proves that production has been deployed.
