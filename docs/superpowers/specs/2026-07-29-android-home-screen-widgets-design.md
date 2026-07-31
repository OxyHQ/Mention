# Android home-screen widgets

Date: 2026-07-29
Status: approved — all three widgets, built in phases

## Goal

Mention on the Android home screen: **trends**, **shortcuts + unread count**, and a **feed list**. Built with Jetpack Glance, styled to Material 3 Expressive, following Google's canonical widget layouts.

## Technology

**Jetpack Glance (Kotlin)**, in one local Expo module `packages/frontend/modules/mention-widgets`, registered by a config plugin — the same shape as the existing `modules/pip-transport`. Glance is what Google's own widget samples use and what the canonical layouts are drawn for; it is also the path that supports Material You dynamic colour and the newer expressive shapes without waiting on a third-party wrapper.

Rejected: `react-native-android-widget` (a third-party dependency in the render path of a system surface, capped at whatever it supports, and another package to fix on every Expo bump) and raw RemoteViews XML (verbose, breakpoints wired by hand, no longer the promoted path).

The three widgets share ONE module, one theme, and one data layer. They are not three projects.

`compileSdk` is 36 and `targetSdk` 35 (`app.config.js`), which is ample for Glance and dynamic colour.

## Design language

Material 3 Expressive, per the user's requirement. Concretely:

- Dynamic colour from the user's wallpaper (Material You) as the default, with Mention's own palette as the fallback where dynamic colour is unavailable.
- The canonical layouts from Google's widget guidance: **grid / text-and-image list** for trends, **standard toolbar** for shortcuts, **text-and-image list** for the feed.
- Responsive by breakpoint via Glance's `SizeMode.Responsive` — not one layout stretched. A toolbar drops its least-used actions as it narrows, which is the documented behaviour.
- 48dp minimum tappable target.
- The precise grid, corner-radius and padding values are NOT in the guidance page; they live in Google's canonical Figma and the `android/platform-samples` widget samples. Take them from there rather than inventing them.

## Phases, ordered by data cost

The expensive part of a widget is not drawing it — it is feeding it while the app is not running. So the order is driven by what each one needs, verified against the real API:

**Phase 1 — Trends.** `GET /trending` is genuinely public: it is mounted on `publicApi` (`appRoutes.ts:98`) and returns 200 with real data to an anonymous request (verified against production). So this widget needs **no session, no credential, no token** — a plain HTTPS GET from a WorkManager job. It delivers a complete, content-bearing widget while proving out Glance, the breakpoints, the refresh schedule and the prebuild, with none of the auth problem.

Note the two obvious-looking URLs are wrong: `/trending/hashtags` and `/hashtags/trending` both 401 because neither route exists and the request falls through to the authenticated router. The route is `GET /trending`.

**Phase 2 — Shortcuts + unread count.** The shortcuts are pure `PendingIntent`s into existing deep links and cost nothing. The unread count is authenticated, so this phase is where the session problem below has to be solved.

**Phase 3 — Feed list.** Authenticated, plus avatars and post images, plus private content rendered on a home screen. The most expensive of the three and the one with the most privacy surface.

## The session problem (phases 2 and 3)

A widget runs **outside the app process**. To read authenticated data it needs the device-first session: the `{deviceId, deviceSecret}` persisted in SecureStore under the shared `so.oxy.shared` UID, exchanged for a short access token at `POST /session/device/token`.

**That belongs in the shared SDK, not in Mention.** The ecosystem rule is explicit: session handling lives in `@oxyhq/core` / `@oxyhq/services` so every Oxy app inherits it. A credential reader written into Mention's widget module would be copied into Homiio and Allo within a month, and would put token-minting logic in three places.

So phases 2 and 3 are gated on an SDK-side piece: a native-readable path to the device credential and a token mint that a background worker can call. That is its own design conversation, deliberately deferred until phase 1 has shipped and there is a working widget to build it against.

**Privacy consequence to decide before phase 3**, not after: a feed widget renders private content on a lock-screen-adjacent surface, and the shared UID means the credential is readable by every same-signature Oxy app. What the widget shows when the session is missing, expired, or the account has been switched must be designed, not defaulted.

## Data refresh

`WorkManager` periodic work, one worker per widget kind, with the interval matched to how fast the content actually changes — trends move slowly (the API's own `calculatedAt` is hourly-ish), so a short interval would burn battery for nothing. Widgets must degrade to their last-known content rather than blanking when a fetch fails, and must never show a spinner as a resting state.

## Non-goals

- iOS widgets. Different framework (WidgetKit), different language, different design system. Out of scope here.
- Interactive widgets beyond taps into the app (no in-widget compose, no in-widget like).
- Any per-app copy of the session logic (see above).

## Verification

None of this can be verified from a Metro bundle. `android/` is gitignored (CNG), so the module and its plugin land only at the next **prebuild / EAS build** and **never over OTA**.

- JS-side logic (action lists, formatting, the refresh policy) gets unit tests that FAIL when the logic is removed — mutation-tested, not merely present.
- The widget itself needs a real device or emulator: place it, resize it across breakpoints, confirm dynamic colour follows the wallpaper, confirm it survives a process death and a reboot, and confirm the failure state renders instead of a blank box.
- Do not report the widget as working on the strength of a green suite.
