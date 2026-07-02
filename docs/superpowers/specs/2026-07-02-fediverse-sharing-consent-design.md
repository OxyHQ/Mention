# Fediverse sharing consent (Threads-style) — design

Date: 2026-07-02 · Status: approved design, pending implementation plan

## Problem

Mention federates every account by default with no user-facing control and no explanation of what the fediverse is. Threads ships a consent surface: an educational flow, an explicit sharing setting, and a fediverse badge. We want the same affordances, adapted to Mention's reality (federation is already live and on for everyone).

## Decisions (made with Nate, 2026-07-02)

1. **Opt-out, default ON.** No regression for existing federated accounts and followers. The educational flow is contextual, not a signup gate.
2. **OFF = full Threads-style shutdown**: actor undiscoverable, inbound follows rejected, nothing delivered, deletion requested from remote servers. Reversible; remote followers must re-follow after re-enabling.
3. **Educational sheet triggers**: tapping the fediverse badge (own profile when sharing is ON, and on federated profiles/posts) and from the Fediverse settings screen.
4. **Dedicated settings screen** (`Ajustes → Fediverso`), not a row buried in Privacy.
5. **Bottom sheet = Bloom UI** (`@oxyhq/bloom/bottom-sheet`) via Mention's existing global `BottomSheetContext`.
6. **The consent flag lives in Oxy** (identity-level, ecosystem-wide), enforced by Mention. Revised from the first draft after Nate's review — see the boundary section.

## Boundary: what lives in Mention vs Oxy

**Oxy owns WHO** — identity and graph, read by the whole ecosystem:
- Federated actors as Oxy users `type:'federated'` (`PUT /users/resolve`).
- The follow graph (`Follow` edges + `_count`), fed by Mention via the service route `POST /federation/follow`.
- User AP signing keys (`/federation/sign`, public-key routes, domain-scoped credentials).

**Mention owns HOW** — wire protocol and app policy:
- `FederatedActor` (transport cache: inbox/sharedInbox URLs, remote public keys).
- `FederatedFollow` (AP state machine: direction, pending/accepted, activity ids for Accept/Undo correlation). Not a duplicate of Oxy's graph — protocol state; the bridge keeps both in sync, idempotently.
- HTTP signatures, delivery queues, inbox processing, media proxying.

**The `fediverseSharing` consent flag lives in OXY** (revised 2026-07-02 with Nate, superseding the first draft). Rationale:
- It is identity-level consent — "my identity may be shared outside the Oxy ecosystem" — not app policy. Oxy already owns the other identity-level federation material (AP signing keys, the federated-user bridge, the follow graph). If a second Oxy app federates tomorrow, it inherits the same single decision.
- Zero hot-path cost: Mention's AP routes ALREADY resolve the user through oxy-api (`resolveOxyUser`) on every actor/webfinger hit and cache the result (`userSummaryCache`). The flag rides on the user DTO Mention already fetches — no extra network call.
- Enforcement and protocol cleanup stay in Mention: Oxy states the decision; the Mention post office enforces it on its own AP surface.

## Backend

### Data + chokepoint

**oxy-api (owns the flag):**
- `privacySettings.fediverseSharing: boolean, default true` on the User model, exposed in the user/profile DTOs (so it arrives wherever the user object already travels), writable by the session user through the existing settings/profile update route (field whitelisted like its siblings), and surfaced by an SDK accessor in `@oxyhq/core`.
- No new Oxy route: it is one more privacy field on existing plumbing.

**Mention (reads it, never stores it):**
- New `services/fediverseSharing.ts` — the ONLY read path: `isFediverseSharingEnabled(oxyUserId)` / `...ByUsername(username)`. It reads the flag from the Oxy user object Mention already resolves and caches (`resolveOxyUser` / `userSummaryCache`, Redis TTL 10m). Default `true` when the field is absent (older DTOs).
- When the toggle is flipped FROM Mention, the app tells its backend to invalidate that user's cache entry immediately (gates flip at once). A flip made elsewhere (e.g. a future Oxy accounts UI) propagates within the cache TTL — documented, acceptable.
- No inline lookups at gates — everything imports the helper.

### Gates (sharing OFF)

| Surface | Behavior when OFF |
|---|---|
| `GET /.well-known/webfinger` for the user | 404 (stops discovery) |
| `GET /ap/users/:username` + `/outbox`, `/followers`, `/following`, user `/inbox` | 404 — indistinguishable from a nonexistent user |
| Shared inbox activities targeting the user (`handleIncomingFollow` and the rest) | dropped silently (debug log) — no `FederatedFollow`, no Oxy bridge, no Accept, no Reject. A `Reject` can't be sent consistently: the remote server couldn't verify its signature against a 404 actor, and answering at all would reveal the account exists |
| Outbound (posts, likes, boosts, follows) | gated once at the connector-agnostic seam — `ConnectorRegistry` deliver/federate entry points check `actorOxyUserId` — so no network sees the user's activity. `follow.service.federateNewPost` keeps a defensive check |
| Read side (viewing federated content in Mention) | untouched — consuming public remote content is not sharing |

### Toggle transitions

- The write goes to OXY (SDK, session-authed). The Mention frontend then calls a small Mention backend endpoint (`POST /federation/sharing-changed`, session-authed) that (a) invalidates the user's sharing cache and (b) on ON→OFF enqueues the protocol cleanup job (BullMQ, Mongo fallback — existing queue conventions; job id hashed, never raw URLs):
  1. Deliver `Delete { object: actorUri }` to the shared inboxes of all inbound followers (Threads-style deletion request; best-effort).
  2. Delete inbound `FederatedFollow` rows and bridge-unfollow their Oxy edges (`POST /federation/follow`, action `unfollow` — idempotent).
- The cleanup endpoint reads the CURRENT flag from Oxy server-side (never trusts the client) and no-ops when sharing is still on — safe to call spuriously, idempotent to re-run.
- **OFF→ON**: no fan-out; cache invalidated so the actor resolves again immediately. Remote followers must re-follow (same caveat Threads documents).
- UI confirms ON→OFF with an explicit warning before writing (see frontend).

## Frontend

- **`app/(app)/settings/fediverse.tsx`** — dedicated screen (Bloom `SettingsListGroup`/`SettingsListItem` + `Switch`):
  - toggle "Compartir en el fediverso" — optimistic UI; writes to OXY via the SDK (the flag lives on the Oxy user), then calls Mention's `POST /federation/sharing-changed` (cache invalidation + cleanup job),
  - the user's federated handle `@user@mention.earth`,
  - row "¿Qué es el fediverso?" → opens the educational sheet,
  - turning OFF first opens a Bloom `Dialog` confirmation: followers will be lost, deletion will be requested from other servers, cannot be guaranteed (Threads wording).
  - Entry row "Fediverso" in `settings/index.tsx`.
- **`components/Fediverse/FediverseInfoSheet.tsx`** — 3-step educational flow inside the global `BottomSheetContext` (Bloom `BottomSheet`, single-detent, internal step state, Next/Back):
  1. Qué es el fediverso (red de servidores interconectados, analogía email).
  2. Cómo funciona compartir (perfil público visible desde otros servidores; cada servidor tiene sus normas; Mention no modera lo remoto).
  3. Tu control (apagar en ajustes; pediremos borrado pero no se garantiza). Final CTA: "Entendido" — or "Activar" when sharing is OFF (writes the setting).
- **`components/Fediverse/FediverseBadge.tsx`** — one component, two placements: own profile header when sharing is ON; federated profiles/posts (next to the `@user@domain` handle). Tap → `FediverseInfoSheet`.
- i18n: keys under `fediverse.*` in `locales/en.json`, `es.json`, `it.json`.

## Error handling

- Oxy settings write fails → optimistic toggle reverts. `sharing-changed` call fails after a successful Oxy write → gates still converge via cache TTL; the endpoint is idempotent and retried by the client once.
- OFF-transition job is retry-safe: Delete fan-out is best-effort per inbox; row deletion + bridge-unfollow are idempotent (re-running converges).
- Redis down → helper falls back to a direct `UserSettings` read (no cached default that silently re-enables sharing).

## Testing

- Backend unit tests: each gate ON/OFF (actor 404, webfinger 404, Reject on follow, outbound skip), cache invalidation on settings write, ON→OFF job (Delete fan-out addressed per shared inbox, rows removed, bridge called), defaults (missing doc → enabled).
- Frontend: typecheck; sheet and toggle verified in a real browser (Jest doesn't catch sheet/layout races — repo convention).
- E2E: toggle OFF → actor 404s from a real fediverse fetch, Mastodon follow gets rejected; toggle ON → discoverable again.

## Out of scope

- `featured`/pinned collection, per-post federation control, atproto bridge surface (stays dark behind `ATPROTO_BRIDGE_ENABLED`).
