# Reel-open latency harness

`reel-open.mjs` measures how long `/videos` takes to put a video frame on screen
after the viewer asks for it, in a real browser against a real origin.

It is **not a gate**. It prints numbers and never fails, which is why it lives
here and not in `../tests` — Playwright's `testDir` is `./tests`, and anything
dropped in there joins the release gate.

## Running it

The harness attaches to a browser you started; it never launches one. That is
the whole point (see below), so the launch is yours to get right:

```bash
Xvfb :97 -screen 0 1280x2000x24 &
DISPLAY=:97 google-chrome \
  --remote-debugging-port=39871 \
  --user-data-dir=/some/scratch/chrome-profile \
  --no-first-run --no-default-browser-check \
  --window-size=430,932 about:blank &

cd packages/e2e/perf
node reel-open.mjs control 2    # sanity first: must print all nulls
node reel-open.mjs open 10      # the measurement
node reel-open.mjs attribute    # one run, with the network inside the window
```

`CDP` (default `http://127.0.0.1:39871`) and `ORIGIN` (default
`https://mention.earth`) are environment variables.

Tear the browser and Xvfb down afterwards and **verify it**, by the port and the
display rather than by `pkill`'s exit status: this machine runs dozens of
unrelated Chrome processes, so `pgrep chrome` answers nothing useful.

## It must be REAL Chrome, not Playwright's Chromium

Playwright ships an open-source Chromium with **no proprietary codecs**. The
videos here are H.264/AAC, so in that browser `canPlayType('video/mp4;
codecs="avc1.42E01E"')` returns `""` and no frame is ever decoded. The harness
would either time out or, worse, be "fixed" by loosening the frame check until
it reported a number that had nothing to do with video.

Real Chrome answers `probably`, and `MediaSource.isTypeSupported(...)` is
`true`. If you change browsers, print those two values first.

`../package.json`'s `install-browser` script installs exactly the browser this
harness must not use. It is there for the gate in `../tests`, which does not
play video.

## What the numbers mean

- **t0** is the `click` event, taken in the capture phase inside the page. Not
  the driver's call: the CDP round trip is tens of milliseconds and would land
  inside the reported number.
- **t1** is `requestVideoFrameCallback`, which fires only when a decoded frame
  is presented. The poster cannot be mistaken for it — the poster is an `<img>`.
  Each run also reports `totalVideoFrames`; a run showing `0` frames is a run
  whose number you should throw away.
- The intermediate columns split the window into route commit, the fullscreen
  `<video>` appearing, `loadedmetadata`, and the frame.

`control` mode clicks **Explore** instead of **Videos** and must print all
nulls with zero frames. Run it whenever the app's navigation changes: if the
control ever produces a number, `open` is timing something that is not the reel
and every number it gives is worthless.

## Things that will bite whoever repeats this

- **Signed out, the route into `/videos` is the left drawer, not the BottomBar.**
  The signed-out web app has no BottomBar at all — a "Sign in" banner occupies
  that space. The harness opens the hamburger at (36, 28) and clicks the drawer's
  "Videos" row. Signed in, the BottomBar exists and the path is different, so a
  signed-in run is not comparable to a signed-out one without changing this.
- **It measures the FIRST open of `/videos` in a page's session.** Repeated
  opens within one session are not automated: after `page.goBack()` the drawer's
  "Videos" row resolves outside the viewport under react-native-web and the click
  never lands. If you need the repeat case, that is the problem to solve first —
  do not assume the first-open number generalises to it.
- **The absolute numbers belong to one machine and one network.** They are only
  meaningful against another run of this same harness on the same setup. Do not
  compare a number from here against a number from anywhere else.
- **The signed-out interstitial appears once per browser profile.** A fresh
  profile sees it, a reused one does not; the harness tolerates both. This also
  means "cold" and "warm" are a property of the profile you launched Chrome
  with, not a mode of this script.
- **The first run against a cold media CDN is an outlier**, and the excess lands
  entirely in the `→metadata` column. Judge by the median, and read the columns
  rather than only the total.

## What this was for

The baseline taken before the shared-player work, so "it feels smoother"
afterwards could be an argument about a measurement instead of an impression.

Note that a shared player changes which metric applies: with the feed's video
already playing, there is no first frame to wait for, and the question becomes
continuity — whether a frame is ever absent and whether `currentTime` advances
monotonically. This harness answers the latency question, which is the right one
only up to the point that work lands.
