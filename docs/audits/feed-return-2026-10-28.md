# Feed return audit — 28 October 2026

Production browser testing confirmed two distinct failures: virtualized rows lose their measured spacing, and returning to a profile through the app's Back button can remove the feed entirely. A successful page load or unchanged URL does not establish that either behavior works.

## Confirmed production failures

| Scenario | Observed result | Owning correction |
| --- | --- | --- |
| Home at scroll 1,200; viewport changes from 1,440×900 to 1,440×850 | Row transforms become 0, 400, 800… while actual heights remain 443.75, 427.75, 203.75, 483.75, 163.75 and 945.75 px. Visible posts overlap by 83.75 px and leave a 236.25 px gap. | Bloom `VirtualList` must retain measurements when synchronizing its origin; clearing the size cache does not remeasure unchanged DOM boxes. |
| Enter Deck, then return to normal layout | Normal-width rows retain real heights but are placed every 400 px; the first pair overlaps by 43.75 px. | Bloom row-measurement callbacks must belong to the current scroll-owner virtualizer. |
| Public profile; scroll 2,764 px; open a visible post; app Back | Returns to the profile URL at scroll 0 with zero post rows and only profile chrome. Reproduced twice. Browser Back at the same depth preserves 11 rows and the reading position. | Existing Mention PR #1634 preserves owning profile parameters through Expo Router child-state seeding. Bloom's Screen retention correction is also required. |
| Authenticated profile; scroll approximately 5,340 px; post; browser Back | The same selected row moves from y=167.75–331.5 to y=1290.75–1454.5, outside the viewport. App Back leaves zero rows. | Deep return must preserve offscreen height measurements as well as route identity. |
| Authenticated Home; deep scroll; post; app Back | In the confirmed run, the selected row moves from y=159–562.75 to y=−1027–−623.25. | Validate reading-anchor preservation against the same post, not just equal scroll offsets. |

[Sanitized numerical evidence](./feed-return-2026-10-28/baseline.json) contains the before/after geometry. Public screenshots show [resize overlap](./feed-return-2026-10-28/height-only-resize.png), [Deck exit overlap](./feed-return-2026-10-28/deck-to-normal.png) and [empty profile return](./feed-return-2026-10-28/profile-app-return.png). No account credentials, sessions or private content are included.

The live deployment SHA was not established by these measurements. The source checkout inspected was `521b11e18`; it must not be presented as proof of the deployed revision.

## Coverage and interpretation

- Chromium desktop: public Home, Explore, profile, post, browser/app Back, height and width changes, Deck entry/exit, search, feed discovery and video playback. Public mobile layout checks at 390×844 found no horizontal document overflow in search, saved, notifications, feeds, lists or channels.
- Authenticated Chromium: deep Home/profile return through both Back mechanisms; read-only saved, lists, channels, notifications, search and videos. The account was neither created nor deleted, and the audit did not publish posts, follow accounts or alter settings.
- Playback reached `readyState=4` with time advancing for the active video; loaded neighboring videos remained paused. This is a playback smoke, not exhaustive codec or device acceptance.
- No uncaught page exceptions were recorded in the completed Chromium samples. Two anonymous asset-resolution HTTP 401s were observed; these alone do not establish a rendering bug.
- Initial DOM counts of five posts were virtualization, not evidence of a five-post feed limit. Scrolling rendered later indices. Timestamp-only visibility was also rejected as an acceptance condition: a timestamp may leave the viewport while its post remains visible. Confirmed return evidence uses the outer post's identity and bounding box.
- Headed WebKit 27.2 under Xvfb completed all four authenticated production return paths and reproduced deep browser-return displacement and the empty app-return profile. [Numerical evidence](./feed-return-2026-10-28/webkit-production.json) records the selected outer row. Headless WebKit on this host stalled frame and scroll-event delivery despite reporting a visible, focused document; those runs were discarded. Native Android/iOS and physical Safari/iOS were not exercised.
- WebKit emitted three access-control errors for feed interaction telemetry during navigation. Their cause is unconfirmed; this does not establish a server CORS configuration defect.

## Candidate validation

The final production export using Bloom **15.60.4**, Mention's canonical restoration keys and the explicit Expo Router adapter passes seven regression cases in Chromium and headed WebKit: deeply scrolled Home and profile return, feed scroll-owner changes, delayed media and resizing, notification app/browser Back, and retained post reading through both Deck transitions. Chromium's broader Deck/profile/route checks passed the other 15 cases. Earlier authenticated Home/profile app/browser Back cases passed with sign-in verified after the feed rendered and traces disabled; live production acceptance remains a separate release step.

Frontend and e2e typechecking pass, as do 54 targeted frontend tests covering route seeding, saved-account isolation, canonical keys, notification surfaces and profile grids. An earlier broader candidate passed 24 layout/media/navigation browser cases; its remaining route-chunk case encountered a confirmed HTTP 429 and subsequently passed on the final candidate. The full merge-queue release gate remains authoritative for the merged tree.

An earlier headed WebKit run against `12ce3141` encountered HTTP 429 from live dependencies, making its final profile result [inconclusive](./feed-return-2026-10-28/webkit-candidate-inconclusive.json). Live probes stopped until the limit reset. The deterministic failures and subsequent passing runs below establish the layout defect independently of that rate limit.

Acceptance requires adjacent visible rows to retain their actual spacing after resize and Deck transitions; the same selected post must remain visible after returning from detail; profile routes must retain their feed and parameters. The local browser tests substitute production-export assets at the production origin, preserving API and session-origin behavior. Their static server does not apply the deployment's header policy; deployment headers and redirects require the Wrangler release gate and live-production verification.


### Earlier local candidate `58078af0`: remaining WebKit failure

The exact four committed `feed-geometry.spec.ts` scenarios ran under headed
WebKit with one worker and no retries. Deck owner switching and delayed-media
loading/width changes passed. Both deeply scrolled Home and profile return
scenarios failed: row spacing was contiguous, but the selected fixture post
was no longer in the viewport after browser Back. Home restored from 4,133 to
2,853 px; profile from 4,031 to 2,967 px. Core data uses 60 deterministic posts,
so this finding is independent of live feed ranking.
[Results](./feed-return-2026-10-28/webkit-candidate-58078af0.json) record the
unchanged test assertions and configuration. This candidate was rejected;
these failures are distinct from the earlier rate-limited run.

A separate diagnostic copy of the Home test recorded actual scroll calls.
It showed the correct saved target, 3,838 px, being restored after Back, followed
by virtualizer adjustments to 3,562, 3,306, 3,070 and finally 2,854 px as rows
were measured. The document's maximum scroll range grew from 14,493 px before
navigation to an estimated 23,453 px on return. Retained DOM handles confirmed
that the original spacer was disconnected: web `Slot` navigation legitimately
unmounted the list. Restoring only its offset recreated the list with estimates
and then moved the reading position as those estimates were corrected.
[Scroll-call evidence](./feed-return-2026-10-28/webkit-restoration-diagnostic.json)
contains only synthetic fixture paths and numerical measurements. No additional
real-account tests were run against this failing candidate.


### Resolved in the 15.60.0 local candidate

Bloom runtime commit `51e3fb13` adds opt-in measurement restoration in the
existing scroll-restoration scope. Its measured rows are saved at route teardown
and seeded before the new virtual range is calculated. Mention supplies canonical
viewer/content identities for feeds, saved posts, notifications and profile grids.
The same route can now restore both its scroll offset and its measured layout
after an actual unmount. Measurement snapshots stay in memory and follow the
store's existing eviction, pruning and clearing lifecycle.

The **same four committed geometry tests now pass in headed WebKit**, with one
worker, no retries and unchanged assertions: deep Home return, deep profile
return, Deck owner changes, and delayed-media/width changes. The run completed
in 30.7 seconds. [Final local evidence](./feed-return-2026-10-28/webkit-candidate-15.60.0.json)
records the runtime source and test conditions. This supersedes the failed
`58078af0` candidate for that geometry run while retaining its diagnostic
history. The run used deterministic feed data and no authenticated account state.

Bloom 15.60.0 was published by the automatic release workflow from commit
`1ca7ddc0f1cd84cb1b026533f34d4b2d83627fd6`. The registry package's 14,211 source
and runtime files matched that validated candidate byte for byte. Mention's
catalog and lockfile temporarily adopted that exact registry version. After rebasing onto main
`3e62c0988`, all four Chromium geometry cases pass again (11.6 seconds), along
with frontend types and 28 focused route/list tests. Lockfile validation and the
security audit pass with the registry dependency.

This establishes the local production export's behavior and published-package
parity. Merged Mention CI, deployment and post-deployment acceptance are separate
release checks. Physical Safari/iOS and native-device coverage remain unperformed
here.

## Merge-queue follow-up: notifications at the end of the list

The full browser gate for candidate `8c7833e2` passed 86 cases but rejected two
notification-return cases, through app and browser Back. The correct inbox and
Likes filter returned, but the scroll position was zero. Both cases reproduced
locally with the unchanged deterministic notification fixture.

The first scroll reached the measured bottom at 1,109 px after the list had
shrunk from its initial estimated height. Bloom treated any height reduction
followed by a bottom offset as a navigation clamp, so it never recorded this
real user scroll. A diagnostic scroll to 500 px recorded and restored 500 px,
confirming that the key and window listener worked. The upstream correction
requires the previous trusted offset to exceed the new maximum before ignoring
a clamped event; genuine user movement to the new bottom remains recordable.

The investigation also found that Mention had omitted Bloom's explicit Expo
Router adapter. Without it, the shell's static `main` identity replaced the
nearest route identity. Mention now supplies the public `expoRouterScrollAdapter`
to its root provider. It reads each screen's own route; Deck retains its separate
memory-navigation scope. Final combined-candidate validation and release status
are recorded separately from the earlier passing geometry-only candidate.


## Final candidate: route-aware owner transfer

The expanded Deck check exposed a separate lifetime defect: the document-to-panel
handoff could be cleared before Expo's deferred focus effect initialized the new
scroll owner. Bloom 15.60.4 keeps that transfer owned by the screen lifecycle,
allows new user scroll input to take over, and clears it when content identity or
the owner changes. Source `030e3058` passed the focused upstream lifecycle tests
and Mention's real browser checks.

The original Chromium test setup also had a distinct synthetic-input race. It
assigned `window.scrollTo(200)` and immediately changed layout before any
200-pixel scroll event had been delivered. Three bounded diagnostic repetitions
recorded that ordering; a run where the event arrived before the click passed.
The test now drives wheel input and observes the source scroll event in each
direction. Its exact 200/300-pixel source checks, nonzero destination offsets,
retained DOM checks and all other assertions are unchanged. No sleeps or retries
were added. This setup correction is separate from the delayed-focus library
failure reproduced in WebKit with the source scroll event already delivered.

Final Chromium checks passed all seven cases in 17.5 seconds, followed by the
symmetric exit-input Deck check in 4.1 seconds. Headed WebKit passed all seven in
24.2 seconds, followed by that final Deck-only input change in 4.7 seconds; the
other six cases were unchanged. [WebKit evidence](./feed-return-2026-10-28/webkit-candidate-15.60.4.json)
records exact test hashes, isolated ancillary requests and the test-input delta.
Frontend types, 37 focused saved-account/key/notification tests, and e2e type and
fixture checks pass. The final registry artifact, merged CI and deployed build
must still be verified independently of these local candidate results.
