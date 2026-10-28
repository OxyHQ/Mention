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

The regression agent reports that the preliminary production export combining Bloom 15.59.3's measurement fix with Mention's scoped router-parameter correction passed three Chromium geometry scenarios and four authenticated return scenarios. The final local Bloom source candidate was `12ce3141`; publication and exact released-artifact validation are separate steps.

A headed WebKit run against that final local candidate kept the selected Home post visible through both Back mechanisms but recorded deep profile browser-return displacement. During that run, live dependencies began returning HTTP 429, then session/profile reads failed and the last scenario could not complete. [Candidate evidence](./feed-return-2026-10-28/webkit-candidate-inconclusive.json) is therefore **inconclusive**, not a clean release failure or pass. All live probes stopped when the shared rate limit was identified. A deterministic deep-profile fixture must establish whether displacement persists without those failures; fresh live acceptance must wait for the limit to reset.

Acceptance requires adjacent visible rows to retain their actual spacing after resize and Deck transitions; the same selected post must remain visible after returning from detail; profile routes must retain their feed and parameters. Tests must run against the production export at the production origin with candidate assets substituted, preserving the real API, CSP and session-origin behavior.
