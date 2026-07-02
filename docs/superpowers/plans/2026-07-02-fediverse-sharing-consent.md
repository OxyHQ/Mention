# Fediverse Sharing Consent (Threads-style) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-user opt-out of fediverse sharing (flag owned by Oxy, enforced by Mention) + Threads-style educational bottom sheet, fediverse badge, and dedicated settings screen.

**Architecture:** Oxy stores `privacySettings.fediverseSharing` (default `true`) and exposes it as a public derived boolean on user DTOs. Mention reads it through the user objects it already resolves (Redis-cached chokepoint `services/fediverseSharing.ts`) and gates webfinger, all `/ap/*` user surfaces, inbound activity handling, and outbound delivery. Toggling OFF triggers a protocol-cleanup job (Delete(actor) to remote servers, remove inbound `FederatedFollow`, bridge-unfollow Oxy edges). Frontend: Bloom BottomSheet educational flow + `FediverseBadge` + `settings/fediverse` screen.

**Tech Stack:** oxy-api (Express+Mongoose+jest), @oxyhq/core SDK, Mention backend (Express+Mongoose+BullMQ+vitest via `bun run test`), Mention frontend (Expo/RN, Bloom UI, i18next).

**Spec:** `docs/superpowers/specs/2026-07-02-fediverse-sharing-consent-design.md` — read it first.

## Global Constraints

- bun/bunx only; never npm/npx.
- No `as any`, no `@ts-ignore`, no `!` non-null assertions, no TODO comments, no silent catches, no inline styles where NativeWind classes exist.
- BOTH repos' main checkouts are owned by OTHER live sessions. ALL work happens in worktrees: `git -C <repo> fetch origin main && git -C <repo> worktree add <path> origin/main` (branch per task group), commits pushed via `git push origin HEAD:main` after tests. Never touch the shared checkouts' git state.
- Mention backend tests MUST run from the package: `cd packages/backend && bun run test` (repo root picks up stale `.dist`). Known pre-existing flaky failure allowed: `feedRanking.test.ts` timeout.
- BullMQ job ids must never contain `:` in the variable part — hash with the existing `shortHash`.
- Deploy order at the end: oxy-api (push main) → publish `@oxyhq/core` → Mention backend+frontend (single push).
- Default is ALWAYS `true`/enabled when the flag is absent (older DTOs, missing docs) — absence must never disable sharing.

---

### Task 1: oxy-api — schema field + public DTO exposure

**Files:**
- Modify: `packages/api/src/models/User.ts` (interface ~line 249-271; schema ~line 548-573)
- Modify: `packages/api/src/services/user.service.ts` (`formatUserResponse`, ~line 1243-1249)
- Modify: the zod body schema used by `PUT /users/:userId/privacy` (`updatePrivacyBodySchema` — locate its definition; if it enumerates keys, add `fediverseSharing: z.boolean().optional()`; if it's a passthrough record, no change)
- Test: `packages/api/src/services/__tests__/formatUserResponse.fediverse.test.ts` (new; follow neighboring service test conventions)

**Interfaces:**
- Consumes: existing `privacySettings` inline subdoc, `formatUserResponse(user, stats?, options?)`.
- Produces: `IUser.privacySettings.fediverseSharing: boolean` (schema default `true`); every DTO built by `formatUserResponse` carries a PUBLIC top-level `fediverseSharing: boolean` (derived: `privacySettings?.fediverseSharing !== false`). Task 3+ (Mention) relies on this exact DTO field name.

- [ ] **Step 1: Write the failing test**

```ts
import { userService } from '../user.service';

describe('formatUserResponse fediverseSharing', () => {
  const base = { _id: '507f1f77bcf86cd799439011', username: 'nate', name: { first: 'N' } };

  it('defaults to true when privacySettings absent', () => {
    const dto = userService.formatUserResponse(base as never);
    expect(dto.fediverseSharing).toBe(true);
  });

  it('is false only when explicitly disabled', () => {
    const dto = userService.formatUserResponse({ ...base, privacySettings: { fediverseSharing: false } } as never);
    expect(dto.fediverseSharing).toBe(false);
  });

  it('does not leak the rest of privacySettings publicly', () => {
    const dto = userService.formatUserResponse({ ...base, privacySettings: { fediverseSharing: true, isPrivateAccount: true } } as never);
    expect(dto.privacySettings).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it** — `cd packages/api && bunx jest formatUserResponse.fediverse -v` → FAIL (`fediverseSharing` undefined).

- [ ] **Step 3: Implement**

In `User.ts` interface, inside the `privacySettings` block: `fediverseSharing: boolean;`. In the schema block (with its siblings): `fediverseSharing: { type: Boolean, default: true },`.

In `user.service.ts` `formatUserResponse`, next to the existing `isFederated` assignment (~line 1249):

```ts
// Public, derived: whether this account participates in fediverse sharing.
// Intentionally public (like isFederated) — the state is observable anyway
// (the AP actor 404s when off). The rest of privacySettings stays private.
response.fediverseSharing = userAny.privacySettings?.fediverseSharing !== false;
```

- [ ] **Step 4: Run** — same command → PASS. Also `bunx jest` (full api suite) + `bunx tsc --noEmit` → green.

- [ ] **Step 5: Verify the profile-by-username route.** `GET /profiles/username/:username` is what Mention's `resolveOxyUser` hits (via `oxy.getProfileByUsername`). Confirm it serializes through `formatUserResponse`; if it returns a raw/lean doc instead, add the same derived field there (same 3-line pattern) and extend the test.

- [ ] **Step 6: Commit** — `feat(api): privacySettings.fediverseSharing (default on) + public derived DTO flag`

---

### Task 2: @oxyhq/core — type + publish

**Files:**
- Modify: `packages/core/src/models/interfaces.ts` (`PrivacySettings` ~line 76-96)
- Modify: `packages/core/package.json` (minor version bump)

**Interfaces:**
- Produces: `PrivacySettings.fediverseSharing?: boolean` — so `oxyServices.updatePrivacySettings({ fediverseSharing: false })` typechecks in Mention (Task 7). `User.fediverseSharing` rides the existing `[key: string]: unknown` index signature (no change needed, but add `fediverseSharing?: boolean` to the `User` interface explicitly for discoverability).

- [ ] **Step 1:** Add `fediverseSharing?: boolean;` to `PrivacySettings` AND to `User` (next to `isFederated`).
- [ ] **Step 2:** `cd packages/core && bunx tsc --noEmit` (or the package build) → green; run its test suite if present.
- [ ] **Step 3:** Commit `feat(core): fediverseSharing in PrivacySettings + User`.
- [ ] **Step 4:** Use the `publish` skill: bump minor, `bun publish`, verify propagation with a clean external `bun add @oxyhq/core@<new>` + `import()`. (Contracts unchanged — no new contracts symbols — so no contracts republish needed.)

---

### Task 3: Mention backend — `services/fediverseSharing.ts` chokepoint

**Files:**
- Create: `packages/backend/src/services/fediverseSharing.ts`
- Test: `packages/backend/src/__tests__/services/fediverseSharing.test.ts`

**Interfaces:**
- Consumes: `oxy` singleton from `server.js` (late `require`, same pattern as `resolveOxyUser` in `connectors/activitypub/constants.ts:175`), `resolveOxyUser(username)`, Redis helper conventions from `services/userSummaryCache.ts` (`withRedisFallback`, `setEx`).
- Produces (used by Tasks 4-6):
  - `isFediverseSharingEnabled(oxyUserId: string): Promise<boolean>`
  - `isFediverseSharingEnabledByUsername(username: string): Promise<boolean>` (also returns `false` for unknown users — callers 404 anyway)
  - `invalidateFediverseSharing(oxyUserId: string): Promise<void>`

- [ ] **Step 1: Failing tests** (mock the oxy client + redis; follow `userSummaryCache` test conventions if one exists, else the repo's vitest mock style):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../server.js', () => ({ oxy: { getUserById: vi.fn() } }));
// mock the redis util module the same way userSummaryCache's tests/mocks do

import { isFediverseSharingEnabled } from '../../services/fediverseSharing';
import { oxy } from '../../../server.js';

describe('fediverseSharing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('true when DTO says true', async () => {
    (oxy.getUserById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'u1', fediverseSharing: true });
    expect(await isFediverseSharingEnabled('u1')).toBe(true);
  });

  it('false when DTO explicitly false', async () => {
    (oxy.getUserById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'u1', fediverseSharing: false });
    expect(await isFediverseSharingEnabled('u1')).toBe(false);
  });

  it('defaults to true when field absent (old DTO)', async () => {
    (oxy.getUserById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'u1' });
    expect(await isFediverseSharingEnabled('u1')).toBe(true);
  });

  it('fails OPEN (true) when oxy lookup throws — availability over privacy for reads; gates 404 on unknown user separately', async () => {
    (oxy.getUserById as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
    expect(await isFediverseSharingEnabled('u1')).toBe(true);
  });
});
```

- [ ] **Step 2: Run** — `cd packages/backend && bun run test fediverseSharing` → FAIL (module missing).
- [ ] **Step 3: Implement.** Shape (mirror `userSummaryCache.ts` redis usage exactly — `withRedisFallback`, `setEx`, `del`):

```ts
const KEY_PREFIX = 'fedisharing:v1:';
const TTL_SECONDS = Number(process.env.FEDIVERSE_SHARING_CACHE_TTL_SECONDS ?? 600);

function readFlag(user: { fediverseSharing?: unknown } | null | undefined): boolean {
  return user?.fediverseSharing !== false; // absent/unknown ⇒ enabled
}

export async function isFediverseSharingEnabled(oxyUserId: string): Promise<boolean> {
  // 1. redis get KEY_PREFIX+oxyUserId → '1'/'0' hit returns immediately
  // 2. miss → const { oxy } = require('../../server.js'); user = await oxy.getUserById(oxyUserId)
  //    (try/catch → on error log warn + return true, do NOT cache)
  // 3. cache setEx TTL_SECONDS, return readFlag(user)
}

export async function isFediverseSharingEnabledByUsername(username: string): Promise<boolean> {
  const user = await resolveOxyUser(username); // already exists; returns public DTO or null
  if (!user) return false;
  const id = String(user.id ?? user._id ?? '');
  // seed the id-keyed cache from this DTO (setEx), then:
  return readFlag(user);
}

export async function invalidateFediverseSharing(oxyUserId: string): Promise<void> {
  // redis del KEY_PREFIX+oxyUserId (withRedisFallback no-op when redis absent)
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `feat(federation): fediverseSharing read chokepoint with redis cache`

---

### Task 4: Mention backend — discovery/AP surface gates (404 when OFF)

**Files:**
- Modify: `packages/backend/src/connectors/activitypub/routes/wellKnown.routes.ts` (webfinger handler, ~line 19)
- Modify: `packages/backend/src/connectors/activitypub/routes/ap.routes.ts` — actor GET (~:129, after `resolveOxyUser` at ~:168), user inbox POST (~:219), outbox (~:294), followers (~:375), following (~:407)
- Test: `packages/backend/src/__tests__/connectors/activitypub/fediverseSharingGates.test.ts`

**Interfaces:**
- Consumes: `isFediverseSharingEnabledByUsername(username)` from Task 3.
- Produces: when OFF, every user-scoped AP/discovery surface returns the SAME 404 shape as an unknown user (no distinguishable body).

- [ ] **Step 1: Failing tests** — supertest-style route tests (follow `apRoutes.test.ts` conventions added recently): mock `fediverseSharing` module; for each route assert 200 when enabled-mock and 404 `{ error: 'User not found' }` (match the existing unknown-user body EXACTLY — read the current 404 literal in each handler first) when disabled-mock. Cover: webfinger, actor, outbox, followers, following, user inbox POST.
- [ ] **Step 2: Run** → FAIL. 
- [ ] **Step 3: Implement.** In each handler, immediately after the existing user resolution succeeds:

```ts
if (!(await isFediverseSharingEnabledByUsername(username))) {
  return res.status(404).json({ error: 'User not found' }); // ← copy the handler's existing unknown-user literal
}
```

For webfinger: after it resolves the local account, before building the JRD. Do NOT touch the shared inbox route (`POST /ap/inbox`) — per-target gating happens in Task 5.

- [ ] **Step 4: Run** → PASS (full backend suite). **Step 5: Commit** — `feat(federation): 404 all user AP surfaces when fediverse sharing is off`

---

### Task 5: Mention backend — inbound drop + outbound seam gate

**Files:**
- Modify: `packages/backend/src/connectors/activitypub/inbox.service.ts` (`handleIncomingFollow`, right after `localUserId` is resolved ~line 166)
- Modify: `packages/backend/src/connectors/ConnectorRegistry.ts` (`federateNewPost` ~:43-66 and the `deliver(event)` fan-out — gate on the event's actor)
- Modify: `packages/backend/src/connectors/activitypub/follow.service.ts` (`federateNewPost` ~:257 — defensive check)
- Test: extend `packages/backend/src/__tests__/connectors/activitypub/inboundFollowBridge.test.ts` + new `packages/backend/src/__tests__/connectors/connectorRegistrySharingGate.test.ts`

**Interfaces:**
- Consumes: `isFediverseSharingEnabled(oxyUserId)` / `...ByUsername(username)` (Task 3).
- Produces: inbound Follow for an OFF user is dropped silently (no `FederatedFollow`, no bridge, no Accept, no Reject); no outbound activity (post/like/boost/follow) leaves ANY connector for an OFF actor. `deliverToFollowers` itself stays ungated (Task 6's cleanup Delete must flow through it after the flag flips).

- [ ] **Step 1: Failing tests.**
  - inbox: sharing-off mock → `handleIncomingFollow` returns without calling `bridgeFollowEdge`/`sendAccept`/`FederatedFollow.findOneAndUpdate` (reuse that file's existing mocks).
  - registry: build a `ConnectorRegistry` with one fake enabled connector; sharing-off mock → `federateNewPost(post,'u1','nate')` does NOT call the connector; sharing-on → does. Same for a `deliver({ kind:'follow.add', ... })` event carrying the actor id (read `LocalNetworkEvent` in `connectors/types.ts` for the exact actor field name and use it).
- [ ] **Step 2: Run** → FAIL. 
- [ ] **Step 3: Implement.** Registry (single seam, before fan-out):

```ts
if (!(await isFediverseSharingEnabled(actorOxyUserId))) {
  logger.debug(`[Connectors] sharing off for ${actorOxyUserId} — skipping federation`);
  return;
}
```

inbox.service.ts (silent drop — a Reject is unverifiable against a 404 actor and would reveal the account exists):

```ts
if (!(await isFediverseSharingEnabledByUsername(username))) {
  logger.debug(`[Federation] inbound follow for ${username} dropped — sharing off`);
  return;
}
```

`follow.service.federateNewPost`: same `isFediverseSharingEnabled` early-return after the `FEDERATION_ENABLED` check (defensive; the registry already gates).

- [ ] **Step 4: Run full backend suite** → PASS. **Step 5: Commit** — `feat(federation): gate inbound handling and outbound seam on fediverseSharing`

---

### Task 6: Mention backend — `POST /federation/sharing-changed` + cleanup job

**Files:**
- Modify: `packages/backend/src/queue/constants.ts` (add `FEDERATION_SHARING_CLEANUP_QUEUE = 'federation-sharing-cleanup'` + concurrency/retention consts)
- Modify: `packages/backend/src/queue/queues.ts` (`getSharingCleanupQueue()` — copy `getPeriodicQueue` shape)
- Modify: `packages/backend/src/queue/producers.ts` (`enqueueSharingCleanup({ oxyUserId, username, nonce })` — jobId `` `sharingcleanup:${shortHash(`${oxyUserId}|${nonce}`)}` ``)
- Modify: `packages/backend/src/queue/workers.ts` (worker + exported `processSharingCleanupJob`)
- Create: `packages/backend/src/connectors/activitypub/sharingCleanup.service.ts`
- Modify: `packages/backend/src/connectors/connectors.routes.ts` (new route — copy the `POST /follow` skeleton at ~:257)
- Test: `packages/backend/src/__tests__/connectors/activitypub/sharingCleanup.test.ts`

**Interfaces:**
- Consumes: `followService.deliverToFollowers(activity, senderOxyUserId, senderUsername)` (delivers to inbound-accepted followers — call it BEFORE deleting rows), `getServiceOxyClient().makeServiceRequest('POST','/federation/follow',{followerUserId,targetUserId,action:'unfollow'})` (bridge — same call `inbox.service.ts` uses), `FederatedFollow`, `FederatedActor`, `actorUrl(username)` + `AP_CONTEXT` from activitypub constants, `resolveUserOr401`/`requireAnyConnector` route helpers, `isFediverseSharingEnabled` + `invalidateFediverseSharing` (Task 3).
- Produces: `runSharingCleanup(oxyUserId: string, username: string): Promise<{ deletesSent: number; followersRemoved: number }>` (idempotent, re-run converges) and the session route `POST /federation/sharing-changed` (no body; 202 `{ status: 'ok', cleanupQueued: boolean }`).

- [ ] **Step 1: Failing tests** for `runSharingCleanup` (mock followService, FederatedFollow, FederatedActor, service client):
  1. builds `{ '@context': AP_CONTEXT, id: `${actorUrl(u)}#delete-${nonce}`, type: 'Delete', actor: actorUrl(u), to: ['https://www.w3.org/ns/activitystreams#Public'], object: actorUrl(u) }` and passes it to `deliverToFollowers` BEFORE any row deletion (assert call order);
  2. bridge-unfollows each inbound follower that has a resolvable `FederatedActor.oxyUserId` (skips ones without);
  3. deletes inbound `FederatedFollow` rows LAST;
  4. zero inbound rows → no deliverToFollowers call, returns zeros;
  5. re-run after completion → no-ops (idempotent).
  Route tests: OFF-flag mock → `enqueueSharingCleanup` called + cache invalidated; ON-flag → invalidated only, no enqueue (the route re-reads the flag from Oxy server-side via a fresh `isFediverseSharingEnabled` AFTER invalidating — never trusts the client).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** service, producer/queue/worker (mirror the periodic queue registration in `startWorkers()`; when `enqueueSharingCleanup` returns false — queue disabled — run `runSharingCleanup` inline fire-and-forget with `.catch(err => logger.error(...))`, same fallback pattern as the inbox 202 path). Route:

```ts
router.post('/sharing-changed', async (req: AuthRequest, res: Response) => {
  if (!requireAnyConnector(res)) return;
  const userId = resolveUserOr401(req, res);
  if (!userId) return;
  try {
    await invalidateFediverseSharing(userId);
    const enabled = await isFediverseSharingEnabled(userId); // fresh read from Oxy
    let cleanupQueued = false;
    if (!enabled) {
      const { oxy } = require('../../server.js');
      const user = await oxy.getUserById(userId);
      if (user?.username) {
        cleanupQueued = true;
        const queued = await enqueueSharingCleanup({ oxyUserId: userId, username: user.username, nonce: String(Date.now()) });
        if (!queued) runSharingCleanup(userId, user.username).catch((err) => logger.error('sharing cleanup inline failed:', err));
      }
    }
    return res.status(202).json({ status: 'ok', cleanupQueued });
  } catch (err) {
    logger.error('sharing-changed error:', err);
    return res.status(500).json({ error: 'Failed to apply sharing change' });
  }
});
```

- [ ] **Step 4: Full backend suite + `bun run build:backend`** → PASS. **Step 5: Commit** — `feat(federation): sharing-changed endpoint + Delete(actor) cleanup job`

---

### Task 7: Mention frontend — settings screen, educational sheet, badge, i18n

**Files:**
- Create: `packages/frontend/components/Fediverse/FediverseInfoSheet.tsx`
- Create: `packages/frontend/components/Fediverse/FediverseBadge.tsx`
- Create: `packages/frontend/app/(app)/settings/fediverse.tsx`
- Modify: `packages/frontend/app/(app)/settings/index.tsx` (add row)
- Modify: `packages/frontend/components/ProfileCard.tsx` (~:96-98 — wrap the existing `FediverseIcon` render in `FediverseBadge`)
- Modify: own-profile header placement — `packages/frontend/components/Profile/ProfileHeader.tsx` (render `FediverseBadge` next to the handle when `!isFederated` and the viewer's own profile has sharing on: `user.fediverseSharing !== false` from `useAuth()`)
- Modify: `packages/frontend/locales/en.json`, `es.json`, `it.json` (keys under `fediverse.*`)

**Interfaces:**
- Consumes: `useAuth()` (`user`, `oxyServices`, `isAuthenticated`) from `@oxyhq/services`; `oxyServices.updatePrivacySettings({ fediverseSharing: value })` (Task 2 type); Mention API client (`utils/api.ts` authenticated client) → `POST /federation/sharing-changed`; `BottomSheetContext` (`setBottomSheetContent(node)` + `openBottomSheet(true)` via `useContext`); Bloom: `SettingsListGroup`/`SettingsListItem` (`@oxyhq/bloom/settings-list`), `Switch` (`@oxyhq/bloom/switch`), `Dialog` (`@oxyhq/bloom/dialog`) for the OFF confirmation; `FediverseIcon` from `@/assets/icons/fediverse-icon`; `useTranslation`.
- Produces: `<FediverseBadge size? className?>` (tap → opens `FediverseInfoSheet` in the global sheet), `<FediverseInfoSheet initialStep? showEnableCta?>`, route `/settings/fediverse`.

- [ ] **Step 1: FediverseInfoSheet.** 3 steps in local state (`useState<0|1|2>`), content per step = icon area (`FediverseIcon` large) + title + body text, footer: primary Button (`Siguiente` / on last step `Entendido` — or `Activar` when `showEnableCta` and sharing is off, which runs the same enable flow as the settings toggle) + secondary (`Atrás` / `Cancelar` closes sheet via `openBottomSheet(false)`). i18n keys: `fediverse.sheet.step1.title|body`, `step2.title|body`, `step3.title|body`, `fediverse.sheet.next|back|done|enable|cancel`. Copy mirrors Threads (adapted, es/en/it): qué es el fediverso (servidores interconectados, analogía email) / cómo funciona compartir (perfil público visible y seguible desde otros servidores; cada servidor tiene sus normas; Mention no modera lo remoto) / tu control (apágalo en ajustes; pediremos borrado a otros servidores pero no se garantiza).
- [ ] **Step 2: FediverseBadge.** `Pressable` wrapping `FediverseIcon`, `onPress` → `setBottomSheetContent(<FediverseInfoSheet …/>); openBottomSheet(true)`. Use it in `ProfileCard` (replacing the bare icon render) and in `ProfileHeader` for the own-profile case.
- [ ] **Step 3: settings/fediverse.tsx.** Structure (copy `settings/privacy.tsx` scaffolding):
  - Group 1: `SettingsListItem` title `t('fediverse.settings.share')`, description with the federated handle `@${user?.username}@mention.earth`, trailing `<Switch value={sharing} onValueChange={onToggle} />`.
  - Group 2: `SettingsListItem` `t('fediverse.settings.whatIs')` → opens the sheet.
  - `sharing` state: initialize from `useAuth().user?.fediverseSharing !== false`; optimistic toggle.
  - `onToggle(false)` → open Bloom `Dialog` confirm (title/body `fediverse.settings.disableConfirm.*`: seguidores del fediverso se perderán; se pedirá borrado en otros servidores; no se puede garantizar) → on confirm run `applyChange(false)`.
  - `applyChange(value)`: `await oxyServices.updatePrivacySettings({ fediverseSharing: value })` → `await api.post('/federation/sharing-changed')` (one retry on failure; if the Oxy write itself failed, revert the switch). No `useEffect` — event handlers only.
  - Row in `settings/index.tsx`: `SettingsListItem icon={<RowIcon name="globe-outline" />} title={t('fediverse.settings.title')} onPress={() => router.push('/settings/fediverse')}` inside the authenticated block.
- [ ] **Step 4: i18n.** Add the full `fediverse.*` key tree to `en.json`, `es.json`, `it.json` (write real copy in all three — no English fallbacks in es/it).
- [ ] **Step 5: Verify.** Frontend typecheck (`bunx tsc --noEmit` in `packages/frontend` if configured — check package.json), then REAL browser verification (Jest/typecheck can't catch sheet races — repo convention): `bun run dev:frontend`, open settings → Fediverso, walk the 3-step sheet, toggle off (confirm dialog) and on, badge tap on a federated profile card.
- [ ] **Step 6: Commit** — `feat(fediverse): consent settings screen, educational sheet, badge (Threads-style)`

---

### Task 8: Ship + E2E

- [ ] **Step 1:** oxy-api: full suite + tsc in its worktree → push `origin HEAD:main` (deploys oxy-api).
- [ ] **Step 2:** `@oxyhq/core` publish (Task 2 Step 4) AFTER the api deploy is green; then bump `@oxyhq/core` in Mention `packages/frontend`/`backend` package.json + `bun install` (lockfile in the SAME commit).
- [ ] **Step 3:** Mention: backend suite from `packages/backend` + `bun run build:backend` + frontend typecheck in the worktree → ONE push to main (backend + frontend + lockfile together — deploy-aws has no concurrency control).
- [ ] **Step 4: E2E on prod:** with a test account, toggle OFF → `curl -H 'Accept: application/activity+json' https://mention.earth/ap/users/<user>` → 404; webfinger → 404; Mastodon follow attempt fails to resolve; existing Mastodon follower sees the account's content deletion request. Toggle ON → actor 200 again; re-follow from Mastodon works (Accept + follower visible in app). Post → delivered. Verify `nate` (sharing untouched, default on) is unaffected throughout.
- [ ] **Step 5:** Spawn docs-keeper: document the flag (Oxy-owned, public derived DTO field, Mention chokepoint + gates + cleanup job) in `Mention/AGENTS.md` federation section.

## Self-review notes

- Spec coverage: data+chokepoint (T1-T3), gates table (T4-T5), transitions (T6), frontend (T7), testing/E2E (T8). Read-side untouched — no task modifies outbox-sync/media (correct).
- `deliverToFollowers` intentionally ungated so the cleanup Delete flows after the flag flips (T5 note).
- Type names consistent: `isFediverseSharingEnabled`/`ByUsername`/`invalidateFediverseSharing`, DTO field `fediverseSharing`, route `/federation/sharing-changed`, queue `federation-sharing-cleanup`.
