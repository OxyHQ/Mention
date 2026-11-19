# Video playback

How Instagram, Facebook and X play video in their mobile apps, how Mention plays it, and the
design Mention follows. Written 2026-11-19. Numbers were measured on a Pixel 8a with release
builds. Where a big app's number is not public, this says so.

## 1. What the big apps do

### Players: few, pooled and reused

- Meta's Android apps used to warm up several players at once. This "consumed significant
  memory and limited preloading to only a few videos". They moved to Media3's
  `DefaultPreloadManager`, which "manage[s] many videos using a single player instance".
  ([Android Developers, 2026](https://developer.android.com/blog/posts/instagram-and-facebook-deliver-instant-playback-and-boost-user-engagement-with-media3-preload-manager))
- Google's short-form sample keeps a pool of **3** ExoPlayers. When a page leaves the screen
  its player gets `stop()` and `clearMediaItems()` and goes back to the pool; it is not
  released. The pager keeps one page either side.
  ([PlayerPool.kt](https://github.com/androidx/media/blob/release/demos/shortform/src/main/java/androidx/media3/demo/shortform/PlayerPool.kt),
  [ViewPagerActivity.kt](https://github.com/androidx/media/blob/release/demos/shortform/src/main/java/androidx/media3/demo/shortform/viewpager/ViewPagerActivity.kt))
- Hardware decoders are scarce ("there may only be one" on some devices).
  ([ExoPlayer codelab](https://developer.android.com/codelabs/exoplayer-intro))
- Reusing a decoder cut startup from 280 ms to 110 ms in one ExoPlayer example. A decoder
  cannot be reused across codecs.
  ([ExoPlayer blog](https://medium.com/google-exoplayer/improved-decoder-reuse-in-exoplayer-ef4c6d99591d))
- Apple publishes no maximum number of AVPlayers. Forum reports range from 4 to 16.

### Preloading: a short slice of the neighbours

- In mixed feeds, Facebook preloads only the current video, "so it starts the moment the user
  pauses their scroll". Instagram Reels keeps the videos on both sides of the current one in
  memory. Counts and seconds are not public. (Meta case study, above)
- Media3's examples preload the next item for **3–5 s** and the previous one for 1–3 s.
  Items 2–4 away only get their source or tracks prepared; anything further gets nothing.
  The sample app keeps ±1–3 items in memory for 1 s and caches 5 s of items further away.
  ([preloading guide](https://developer.android.com/media/media3/exoplayer/preloading-media/preloadmanager/create),
  [Media3 blog](https://android-developers.googleblog.com/2025/09/introducing-preloading-with-media3.html))
- Two cautions from Media3 and Meta:
  - Far items must be removed, or memory runs out.
  - Preloading must share the playing video's bandwidth meter and load control, so it never
    starves the video being watched.
  
  Meta also pauses preloading when the device's CPU or I/O is under stress.
  ([Media3 blog part 2](https://developer.android.com/blog/posts/elevating-media-playback-a-deep-dive-into-media3-s-preload-manager-part-2))
- Instagram's list framework (IGListKit) uses a "working range" measured in screens around
  the visible ones.
  ([IGListKit](https://github.com/Instagram/IGListKit/blob/main/Guides/Getting%20Started.md))

### Buffers

- Media3's `DefaultLoadControl` defaults:
  - 50 s minimum and maximum buffer;
  - 1 s before playback starts, 2 s after a rebuffer;
  - about 131 MB for video.
  
  ([DefaultLoadControl](https://developer.android.com/reference/androidx/media3/exoplayer/DefaultLoadControl))
- Google's short-form sample uses 5 s minimum, 20 s maximum and 0.5 s to start.
- Meta's tuned values are not public.

### Adaptive bitrate and encoding

- Instagram makes a basic ABR ladder for every video (DASH) and adds advanced encodings for
  the videos that get watched most.
  ([Meta, 2022](https://engineering.fb.com/2022/11/04/video-engineering/instagram-video-processing-encoding-reduction/))
- Facebook produces fast H.264 ABR first, then VP9 and AV1 where predicted watch time pays
  for them. ([Meta, 2021](https://engineering.fb.com/2021/04/05/video-engineering/how-facebook-encodes-your-videos/))
- On Reels, a 1080p upload gets 35 AV1 encodings. Low-end phones get AV1 up to 540p.
  ([Meta, 2023](https://engineering.fb.com/2023/02/21/video-engineering/av1-codec-facebook-instagram-reels/))
- X appears to serve HLS with fMP4 segments. This comes from third-party observation; there is
  no official post.

### Posters and first frame

- Facebook preloads "metadata, thumbnails and buffered content before a video reaches the
  viewport".
  ([Meta, 2026](https://engineering.fb.com/2026/03/18/ml-applications/friend-bubbles-enhancing-social-discovery-on-facebook-reels/))
- For images, Facebook ships a 200-byte preview inside the API response. How the big apps make
  video posters is not public.
- Instagram's 2018 startup metric was the share of plays that start within 1 s.
- Apple's WWDC16 session 503 gives AVPlayer advice:
  - attach the layer at its real size early;
  - load the asset's properties before play;
  - keep about 5 s of forward buffer to start.

### Autoplay, sound, scrolling

- Autoplay is muted by default:
  - Instagram keeps sound on once the viewer turns it on, until the app closes.
  - X plays muted and unmutes on a tap.
  - Facebook plays with sound unless the phone is silenced.
- Only one video plays at a time.
- Facebook started autoplay at 50% of the video on screen, and found that 100% retained
  viewers better.
- Videos are prepared while the list scrolls and start when the scroll settles. Facebook
  turns decorative animation off during an active scroll. No app publishes fling-specific
  rules.

### Disk cache, full screen, data saver

- Meta moved from prefetching to disk to preloading in memory. Media3 can cache to disk too
  (`STAGE_SPECIFIED_RANGE_CACHED`).
- **Full screen:** Media3 moves one player to another view with `PlayerView.switchTargetView`,
  without rebuffering.
- **Data saver:**
  - Instagram's "Use less cellular data" stops preloading on cellular.
  - Facebook's Data Saver turns off autoplay and lowers resolution.
  - X's data saver turns off autoplay and lowers image quality.
- **Low-end devices:** Meta chooses resolution and codec by a device benchmark.

### The key things they do

1. Keep very few players alive (one, or a pool of three) and reuse them rather than build and
   destroy them.
2. Preload a few seconds of the next video or videos, not the whole feed, under a byte budget.
3. Play exactly one video, muted by default, chosen by visibility.
4. Show a poster or thumbnail immediately and swap to video on the first frame.
5. Use adaptive bitrate with a ladder sized for the device.
6. Never let preloading starve the playing video, and back off under load.
7. Let the viewer save data: no preload or no autoplay on cellular, lower quality.

## 2. Mention before this change

- **Feed** (`components/Feed/Feed.native.tsx`, FlashList, `drawDistance` 1000 px):
  - Every mounted video row leased a registry player at mount (`FlyableVideo` →
    `useVideoPlayerLease`) and released it at unmount.
  - Each lease was a prepared ExoPlayer with its own MediaSession and decoders.
  - Each buffered up to **50 s** ahead (expo-video keeps Media3's defaults until
    `bufferOptions` is set; its docs say 20 s).
  - One video was audible. That was elected by Bloom's `video-playback` from the list's
    viewable keys (50% visible).
- **Reels** (`app/(app)/(tabs)/videos.tsx`):
  - A window of up to 6 players: 2 ahead, 3 behind.
  - Neighbours wait until the active video has 6 s buffered.
  - Posters are prefetched 4 slides ahead.
  - Each slide builds its own `useVideoPlayer`, so players are destroyed and rebuilt as you
    swipe, each with the 50 s buffer.
- **No disk cache:** `useCaching` is off. A looping clip and a scroll back download again.
- **Backend:**
  - Oxy transcodes uploads into an H.264 HLS ladder: 360p at 500 kb/s, 720p at 1 Mb/s and
    1080p at 2 Mb/s, in 2 s MPEG-TS segments (`oxy/packages/api/src/services/video-renditions.ts`).
  - Mention emits `hlsUrl` only once `hlsReadyAt` is set, with the original as fallback.
  - The poster is Oxy's 256 px `thumb` image. Federated video goes through `/media/proxy`, with
    a frame extracted at `/media/poster`.

Baseline numbers are in section 4.

## 3. The design

The aim is one mechanism per problem, with nothing visibly different.

| Problem | Mechanism | Where |
| --- | --- | --- |
| Every mounted row holds a player | The list publishes a **preload window**: the viewable rows, 2 below and 1 above. A row holds a player only while it is in that window. The window survives the 100 ms gap with nothing viewable. A screen in the background keeps only its on-screen rows. | Bloom `ViewableKeysStore.publish(keys, nearKeys)` and `useViewableNear`; Mention `Feed.native.tsx` |
| Building and destroying ExoPlayers | A **parking pool**. A released player is paused, muted and emptied (`replaceAsync(null)` frees its decoder and buffer), then handed to the next video. At most 2 wait. | `stores/videoPlayerRegistry.ts` |
| The row's buttons and poster must not change when it gets or loses its player | `VideoSurface` takes `player: null` and draws what it draws before a first frame (poster, mute button, tap area). The same component takes the player later, so nothing remounts. | Bloom `useVideoPlaybackControl(null)`; Mention `VideoPlayer.tsx` and `useVideoPlayerEvent` |
| A 50 s buffer per player | `VIDEO_BUFFER_OPTIONS`: 10 s ahead, 1 s to start, on every player Mention builds. | `utils/videoSource.ts` |
| Loops and revisits download again | expo-video's disk cache (`useCaching`) on Android, HLS included. iOS cannot cache HLS; the web uses the browser cache. | `utils/videoSource.ts` |

Rows in the window but off screen are prepared and paused, so a row scrolling in already shows
its first frame and starts at once. A row that is flung into view before it was in the window
shows its poster until it plays, which is what every row did before this change. Election of
the audible video, muted-by-default and the 50% threshold are unchanged.

## 4. Measurements (Pixel 8a, release builds)

The baseline is `perf/idle-and-startup` (`78fc2e211`). "After" is this branch. Both builds use
the same packed Bloom and carry an identical, uncommitted probe that logs how long a video
took to be playing once it was allowed to play.

The runs were interleaved on the owner's signed-in account. The feed and reels content
changes between runs, so these are medians over runs, not paired samples.

The scripts are in the scratchpad (`video-agent/bin`):

- `vmeasure.sh`: cold start, 30 drags of Home, the Videos tab and 8 swipes.
- `vreel.sh`: 10 s on the first reel, 20 s sitting on it, 3 swipes, 20 s sitting again.

Network bytes are the app's UID totals from `dumpsys netstats`. Decoders are the app's
entries in `dumpsys media.resource_manager`.

| What | Before | After |
| --- | --- | --- |
| Data, sitting 20 s on one reel (median of 8 / 8) | 26 MB (9–133) | 1 MB (0–26) |
| Data, 3 reel swipes (4 / 4) | 118 MB | 54 MB |
| Data, the whole Videos-tab scenario, about 45 s (4 / 5) | 416 MB | 204 MB |
| Reel plays that took over 1 s to start | 10 of 38 (26%) | 4 of 27 (15%) |
| Reel time to playing, median | 78 ms | 55 ms |
| Home feed video time to playing, median (12 / 10 plays) | 102 ms | 96 ms |
| Home scroll janky frames out of about 4,200 (5 / 3 runs) | 88 | 63 |
| Home scroll frame time, p99 | 24 ms | 20 ms |
| App memory (PSS) at the end of the Videos tab | 883 MB | 809 MB |
| Video decoders held in the Videos tab | 5–9 | 8–11 |

What the numbers say:

- **Data.** Most of the saving comes from the 10 s forward buffer. Before, each of the reel's
  six players filled 50 s ahead, so sitting on one video kept downloading for its
  neighbours. The disk cache is the rest: a looping video no longer downloads again.
- **Startup.** Fewer reel plays stall past a second. That fits the Media3 and Meta advice:
  bounded preloading no longer takes bandwidth from the video being watched.
- **Home feed.** On this account the feed showed only 2–5 videos per 30 drags. So its
  ExoPlayer and decoder counts do not separate, and its time to playing is unchanged at about
  100 ms.
  - The row harness (`components/Feed/__perf__`) shows the structural change: a mounted row
    outside the window holds no player (157 components and 331 hooks, against 169 and 349
    when attached).
  - A row that comes on screen while attached was preloaded before it got there.
  - Before the viewability-gap fix (`2a050760a`), two home plays took 705 and 898 ms. The
    row had given back its preloaded player for the 100 ms gap between one viewable row
    leaving and the next being reported. With the fix, every home play started within
    85–116 ms, except one at 380 ms.
- **Decoders.** The Videos tab still builds one player per slide (up to 6), so its decoder
  count did not fall. See the proposal "Reels on the pool" below.

Not measured: battery (no `batterystats` session), iOS, and the web.

## 5. Proposals that need the owner

These are not built; each one needs a backend, encoding or dependency decision.

- **Poster size.** The poster is the 256 px `thumb`, drawn into a card about 1000 px wide on a
  phone, so it shows soft until the first frame. A poster rendition at about 720 px (or the
  existing `w320`/larger image variant) would look closer to the video.
  - This is an Oxy variant change.
  - It also changes the look, so the owner must approve it.
- **fMP4 (CMAF) segments and a shorter first segment.** The ladder uses 2 s MPEG-TS segments.
  fMP4 is what X appears to use, and a 1 s first segment would let playback start on less
  data. This is an Oxy transcoding change.
- **Disk cache size.** expo-video's cache defaults to 1 GB on disk. The setting is
  `setVideoCacheSizeAsync`, which must be called before any player exists. A smaller budget
  (for example 256 MB) is a product decision.
- **Data saver.** No preloading and no autoplay on cellular, as Instagram, Facebook and X do.
  Bloom's `videoAutoplay` preference exists; a "cellular" mode needs a network-type source
  (`expo-network` or NetInfo) and a settings entry.
- **Reels on the pool.** The reels screen still builds a player per slide (up to 6 alive).
  Leasing them from the same registry by media key would reuse players across swipes, and with
  the feed. This is a larger refactor of `videos.tsx`, kept separate.
