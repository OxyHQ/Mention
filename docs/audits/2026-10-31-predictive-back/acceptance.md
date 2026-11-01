# Android predictive Back acceptance

Status: native integration enabled; physical acceptance pending. The candidate manifest
enables predictive Back with source-built React Native, shared native ownership,
and the Bloom and React Native Screens opt-in adapters. Ordinary Back passing
is not evidence that the predictive preview works.

On 2026-11-01 the user explicitly requested merging the completed integration
without waiting for the paused device session. The checks below remain pending
after merge; issue #888 must not mark predictive rendering as physically verified
until they are performed. No further device input was made for this merge.

First inspect the diagnostic candidate on a normal signed release APK. Final
acceptance requires official published Bloom dependencies and repeating the core
preview, cancellation, commit, overlay, and root-exit cases. Record the
source commit, APK SHA-256, installed package, Android version and device. Keep
private screenshots and logs local. Do not publish test content. Run each
cancel/commit pair from the same known history; a completed previous case changes
that history.

| Setup | During gesture / cancellation | On completion |
| --- | --- | --- |
| Home → Search, keyboard dismissed | Home is visible behind Search; cancel leaves Search selected and preserves its input and history | Home becomes selected once; no Activity exit |
| Home → Profile → Notifications | Preview shows Profile, not a fixed Home destination; cancel preserves Notifications | Profile becomes selected; next Back previews Home |
| Cold explicit tab link | Preview matches the actual navigator history; no fabricated destination | Follows the real tab/root exit policy |
| Home → post detail | Home appears behind detail; cancel preserves detail and its scroll | Pops only detail and returns to Home |
| Home → post → another profile | Previous post appears, not the root tab; cancellation preserves profile | Pops only profile; Profile root pill stays unselected |
| Exhausted root history | Android system home preview appears; cancel leaves Mention active | Exits normally, without resurrecting a replaced route |
| Cold missing route → Go home | Cancel leaves the replacement root intact | System exit, no crash and no return to the missing route |
| Keyboard visible | Keyboard owns Back before app history | Dismisses keyboard without changing tab |
| Drawer or sheet open | Overlay owns Back; underlying history remains unchanged | Closes only the overlay |
| Navigation guarded by preventRemove | Guard remains authoritative throughout cancellation and completion | No silent route removal or duplicate confirmation |
| Prior destination is Camera | Preview never activates CameraView or microphone | Sensor may activate only after focus is committed |
| Prior destination is Videos | Preview never starts background audio or changes the current clip | Playback follows committed focus policy |
| Account/route changes while gesture is active | Stale preview is cancelled and cannot reveal the previous viewer's content | No stale history commit |

Repeat with reduced motion enabled and disabled, and interrupt an in-progress
gesture by backgrounding the Activity; resuming must not commit stale history.

Repeat both screen edges, short cancelled and long committed gestures, and rapid
successive gestures. Verify no double pop, lost bottom bar, native/JS route
mismatch or fatal exception. Confirm ordinary three-button Back still works.

Shared-library tests must drive lifecycle callbacks rather than only assert
configuration strings. They must cover cancellation with unchanged history and
focus, exactly-once commit, stale gesture identifiers, owner replacement and
handoff to native stack/system exit. Mention's wiring checks supplement these;
they cannot certify an Android preview without a native build and device proof.
