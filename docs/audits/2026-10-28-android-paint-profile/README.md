# Android feed reprofiling and paint cache — 2026-10-28

Issue [#1280](https://github.com/OxyHQ/Mention/issues/1280) was reprofiled on the
current React Native 0.88.0 / Expo 58.0.19 application. Its older React Native
0.86 Fabric/Yoga diagnosis does not describe the largest cost in this sample.
The resulting correction belongs to Bloom's Android decorative paint layer,
released in [Bloom #512](https://github.com/OxyHQ/Bloom/pull/512) as 15.60.6.

This record contains aggregate measurements and build hashes only. Feed text,
account identifiers, device serials, screenshots and authentication/session data
are deliberately excluded. Machine-readable measurements are in
[metrics.json](./metrics.json).

## What the profile showed

An 85-second, 200 Hz `cpu-cycles` simpleperf capture on a physical Pixel 8a,
arm64 release build, attributed 43.42% of application cycles to RenderThread,
21.74% to the JS thread and 17.30% to the UI thread. Within RenderThread, inclusive
samples included `CanvasContext::draw` (72.57%), `GrDrawingManager::flush`
(32.28%), `RenderNode::prepareTreeImpl` (21.32%), rounded-rectangle drawing
(10.57%) and shape-mask filtering (9.53%). Within the JS thread,
`EventQueue::flushStateUpdates` accounted for 33.39% and Yoga `layoutTree` for
11.37%. Inclusive percentages overlap and must not be added.

Yoga remains a cost; this does **not** establish that Yoga or Fabric updates
were eliminated. The changed runtime, feed content and device thermal state
also prevent attribution of the difference from the September baseline to one
change. The current profile justified testing paint reuse instead of applying
the historical Yoga hypothesis without remeasurement.

## Controlled A/B/A/B

The existing `packages/frontend/scripts/perf/android-feed-scroll.sh` drove
40 drags per measured run: 1,300 px over 700 ms, with a 600 ms pause. Each variant
had a discarded warm-up. CPU values below are deltas in 10 ms ticks; memory is
KiB. A separate phase captured 24 fast flings (1,600 px over 60 ms).

A and B were interleaved in the same device/feed window. A used Bloom source
`33ff1da5` (15.60.4); B used `7914c596`, whose production delta is Android
hardware-texture caching of the childless decorative `SurfacePaint` view when
it has a rim or sheen. It does not cache post content, plain fills, iOS or web
surfaces. These were diagnostic packs; production consumption uses the
published 15.60.6 package.

| Run | Janky frames | p90 / p99 ms | RenderThread ticks | JS ticks | UI ticks | RSS KiB | EGL + GL KiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A1 | 8.40% | 24 / 34 | 4,064 | 2,288 | 1,985 | 831,880 | 182,932 |
| B1 | 1.35% | 12 / 21 | 2,808 | 2,094 | 1,586 | 895,092 | 180,660 |
| A2 | 4.10% | 21 / 32 | 4,041 | 2,251 | 1,855 | 888,956 | 181,876 |
| B2 | 0.99% | 10 / 19 | 2,525 | 2,035 | 1,548 | 846,508 | 187,020 |

Across these two pairs, mean RenderThread CPU fell **34.2%**. Mean RSS rose
approximately 1.2%; tracked EGL + GL memory rose approximately 0.8%. The RSS
increase in B1 alone is not representative of both pairs. The gain reproduced
in both pairs, but this small sample on one device is not a universal device
budget or a confidence interval. No existing performance ceiling was raised.

### Blank rows and appearance

A1 had 4/24, A2 3/24 and B2 2/24 screenshots with a blank band of at least
300 px. **The whole B1 fling sample is invalid**: its frames 1-8 through 1-12
showed post detail after a gesture navigated away from Home. Its separately
recorded drag phase remained on Home and is retained in the CPU/frame table.
The valid A2/B2 comparison does not prove that blank rows have been eliminated.
A 60 ms adb gesture can be interpreted as a tap when scheduling stalls; this
observation alone did not justify changing application gesture behavior.

A subsequent build combining the cache with the shared CSS registry correction
was checked on-device for light → dark → light repaint and pressed Select
presentation. Decorative fills/rims repainted, and the Select sheet remained
visible. Original account theme synchronization was restored. This is an
invalidation/appearance check, not another performance run.

## Build provenance and reproducibility

SHA-256, computed from the actual installed-test APK artifacts:

| Artifact | SHA-256 |
| --- | --- |
| A baseline | `a3302abe1fe22f4b2df9f99ae71b910ffb1125f0049204bbc99356868751659c` |
| B decorative cache | `88e5e5643d348c7852e3bc6e8df51fc0935a7ab067c92a7cfdca4933a1bdcaf7` |
| Cache + CSS appearance check | `517620dc237ebea4aa8a354aeaa7a3d83730ffdb5bc3a40babb1484285bd909f` |

Dependency-only diagnostic swaps initially left Gradle's JS bundle task
`UP-TO-DATE`. The generated bundle was removed and Metro/Hermes rebuilt for
each variant; indexed source maps were inspected for the intended source.
A changed package installation or APK filename alone is not sufficient proof
that the changed code ran.

The final SDK adoption also exposed a local same-version installation trap:
Bun retained an earlier diagnostic core 7.7.0 directory even after the lockfile
resolved the official registry integrity. The official tarball contained the
correct implementation. Moving aside only the consumer's generated core/services
directories and reinstalling the frozen registry lock corrected the local tree;
installed source and compiled owner guards were compared with the official
artifacts before building. This was not a registry publication defect.

For profiling, only the ignored, generated diagnostic release manifest enabled
`profileable` with shell access. The APK remained non-debuggable and used the
existing release signing configuration. `simpleperf --app earth.mention.app`
worked; attaching with `-p` was denied. No root, kernel change, debug signing or
production profiling default was introduced. On this WSL host, the existing
script's `ADB` override selected Windows Android SDK adb; absence of a Linux
USB bus did not mean the connected device was unavailable.

## Adoption and remaining acceptance

The cache is published in `@oxy.so/bloom@15.60.6`. The final Mention SDK/native
upload adoption PR also pins that official version. Acceptance of that exact
consumer APK is pending and must be recorded before treating #1280 as complete.
The historical September measurements in `docs/PERFORMANCE_BUDGETS.md` remain
historical evidence. Residual blank bands, Yoga work, other devices and iOS
remain separate measurement concerns; this audit makes no claim to remove all
native scroll costs.
