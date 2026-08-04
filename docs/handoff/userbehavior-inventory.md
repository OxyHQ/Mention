# `UserBehavior` — per-line inventory

Measured against a **pinned snapshot of `41deedbd`** (`git archive` into
`scratchpad/snap/`), not the live worktree, which was moving during the audit.
553 production files scanned of 1062 walked; tests and `src/migrations/` counted
separately below.

Reproduce: `node measure-gaps.mjs snap/packages/backend`

Target tables already exist — `src/db/schema/userProfile.ts`: `userBehaviors`
(line 70), `userBehaviorAuthors` (118), `userBehaviorTopics` (146),
`userBehaviorRegions` (173).

---

## The 8 runtime uses of the `UserBehavior` binding (4 files)

This is the figure the brief states, independently reproduced.

| # | Site | Call |
|---|---|---|
| 1 | `src/routes/profileSettings.ts:466` | `const result = await UserBehavior.findOneAndDelete({ oxyUserId });` |
| 2 | `src/services/ContentAffinityService.ts:270` | `return await UserBehavior.findOne({ oxyUserId: viewerId }).lean<IUserBehavior>();` |
| 3 | `src/services/FeedRankingService.ts:473` | `userBehavior = (await UserBehavior.findOne({ oxyUserId: userId }).lean()) ?? undefined;` |
| 4 | `src/services/UserPreferenceService.ts:189` | `let userBehavior = await UserBehavior.findOne({ oxyUserId: userId });` |
| 5 | `src/services/UserPreferenceService.ts:193` | `userBehavior = new UserBehavior({` ← **write path, constructor** |
| 6 | `src/services/UserPreferenceService.ts:653` | `const userBehavior = await UserBehavior.findOne({ oxyUserId: userId });` |
| 7 | `src/services/UserPreferenceService.ts:710` | `return await UserBehavior.findOne({ oxyUserId: userId }).lean<IUserBehavior>();` |
| 8 | `src/services/UserPreferenceService.ts:722` | `const userBehavior = await UserBehavior.findOne({ oxyUserId: userId });` |

## Three more touches NO binding scan reports — these are the ones that bite

| Site | Call | Why the scan misses it |
|---|---|---|
| `src/services/UserPreferenceService.ts:334` | `await userBehavior.save();` | the receiver is the loaded **document**, lowercase — the model binding never appears |
| `src/services/UserPreferenceService.ts:737` | `await userBehavior.save();` | same |
| `server.ts:511` | `require("./src/models/UserBehavior"); // Load UserBehavior model` | a **`require()`**, so an `import … from` walk cannot see it at all |

`server.ts:510-511` sit inside `db.once("open", …)`. Both `require`s are
Mongoose model registration at connect time. **Deleting `models/UserBehavior.ts`
without removing line 511 throws `MODULE_NOT_FOUND` inside an event handler at
startup** — after the port's tests are green, on a path no test exercises.
`require("./src/models/Post")` on line 510 is the same shape, still live.

## Type-only, correctly excluded from the runtime count

- `src/services/ranking/signalContext.ts:18` — `import type { IUserBehavior }`.
  Not a call site, but the type must be rehomed or the file stops compiling when
  the model is deleted.

## 9 test files mock the model — every one goes VACUOUS on the port

`vi.mock('../../models/UserBehavior', …)`. Once the read is Drizzle the mock is
inert, the code hits an unconnected pool, and the test still passes. Move each
onto real rows or delete it; do not leave it mocking a module nothing imports.

```
src/__tests__/services/userPreferenceRegion.test.ts:30
src/__tests__/services/userPreferenceConcurrency.test.ts:68
src/__tests__/services/userPreferenceTopics.test.ts:26
src/__tests__/services/surfaceAttribution.test.ts:29
src/__tests__/services/contentAffinityService.test.ts:51
src/__tests__/routes/profileSettingsFediverseLanguage.test.ts:114
src/__tests__/routes/profileDesignVisibilityParity.test.ts:80
src/__tests__/routes/profileSettingsReadMoreBio.test.ts:40
src/__tests__/routes/profileSettingsExternalEmbeds.test.ts:122
```

`userPreferenceConcurrency.test.ts:68` is the one to read first: its mock is
**both a constructor and a static holder**, written that way precisely because
the service does `new UserBehavior(...)` at site 5. It is the existing test of
the load-modify-`.save()` race at sites 4→334 and 8→737. That race is the reason
this model is not a mechanical port: two concurrent requests for one viewer both
read, both mutate their own document, both save, and the second overwrites the
first. Per the repo's own rule, a concurrency guarantee is only observable under
concurrency — hold the row in an uncommitted transaction and require the racer
to block, with a timeout that THROWS.

## Direction of the false answer

**Background/ranking path — nothing is watching.** `ContentAffinityService:270`
and `FeedRankingService:473` both coalesce a miss to `undefined`/neutral, and
`UserPreferenceService` treats "no document" as a cold viewer and builds a fresh
one at site 5. Once the writes move and these reads do not (or the reverse), the
answer is a silently **empty** behaviour profile: affinity, preferred topics and
preferred region all read neutral, ForYou degrades to generic ranking on every
request, and **no error is produced anywhere**. This is the model the brief flags
as Mongo-AUTHORITATIVE with zero Postgres writers, so a partial port strands the
accumulator: writes land in one store, ranking reads the other, and the feed just
quietly gets worse.

`profileSettings.ts:466` is the exception — a request path, a user-initiated
delete. Its false answer is "deleted nothing" while reporting success.
