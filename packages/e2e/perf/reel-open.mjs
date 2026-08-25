/**
 * How long the reels screen takes to show a video frame, measured in a real
 * browser against a real origin.
 *
 * NOT a gate and deliberately not under `tests/`: it prints numbers and never
 * fails, so Playwright's `testDir` must never discover it. Read `README.md` in
 * this directory before trusting a number out of it — the browser it runs in is
 * load-bearing.
 *
 *   node reel-open.mjs open       [n]  # the measurement
 *   node reel-open.mjs control    [n]  # must print all nulls; proves the rest measures something
 *   node reel-open.mjs attribute       # one run, with the network inside the window
 *   node reel-open.mjs continuity [n]  # does the video survive the route change (POST is the id)
 *   node reel-open.mjs geometry   [n]  # does the flight LOOK like a flight, not a jump
 *
 *   CDP=http://127.0.0.1:39871  ORIGIN=https://mention.earth
 */
import { chromium } from '@playwright/test';

const CDP = process.env.CDP ?? 'http://127.0.0.1:39871';
const ORIGIN = process.env.ORIGIN ?? 'https://mention.earth';
const VIEWPORT = { width: 430, height: 932 };
/** A post carrying a video — the origin surface for `continuity`. */
const POST = process.env.POST ?? '6a390d4ce0e49135be51eb1b';

/**
 * Runs in the page, before the click.
 *
 * `t0` is taken from the click event itself in the capture phase, not from the
 * driver's call into the page: the round trip through CDP is tens of
 * milliseconds and would land inside the number being reported.
 *
 * The first frame comes from `requestVideoFrameCallback`, which fires only when
 * a decoded frame is actually presented. That is what makes the poster
 * unable to be mistaken for the video — the poster is an `<img>`, and no amount
 * of it showing will trigger this. The height test picks the fullscreen reel
 * surface over any thumbnail that happens to be a `<video>`.
 */
const INSTRUMENT = () => {
    const S = { t0: null, tRoute: null, tVideoEl: null, tMeta: null, tFirstFrame: null, frames: 0, src: null };
    window.__reel = S;
    const now = () => performance.now();

    addEventListener('click', () => { if (S.t0 === null) S.t0 = now(); }, true);

    const seeRoute = () => {
        if (S.t0 !== null && S.tRoute === null && location.pathname.startsWith('/videos')) S.tRoute = now();
    };
    for (const method of ['pushState', 'replaceState']) {
        const original = history[method];
        history[method] = function (...args) { const r = original.apply(this, args); seeRoute(); return r; };
    }
    addEventListener('popstate', seeRoute);
    setInterval(seeRoute, 16);

    const attach = (video) => {
        if (video.__wired) return;
        if (video.getBoundingClientRect().height < innerHeight * 0.6) return;
        video.__wired = true;
        if (S.tVideoEl === null) S.tVideoEl = now();
        video.addEventListener('loadedmetadata', () => { if (S.tMeta === null) S.tMeta = now(); }, { once: true });
        video.requestVideoFrameCallback?.(() => {
            if (S.tFirstFrame !== null) return;
            S.tFirstFrame = now();
            // A frame count of zero would mean this fired without a decoded
            // frame behind it, which is the one way the number could lie.
            S.frames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? -1;
            S.src = (video.currentSrc || video.src || '').slice(0, 90);
        });
    };
    const sweep = () => { for (const v of document.querySelectorAll('video')) attach(v); };
    new MutationObserver(sweep).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(sweep, 16);
};

/**
 * The signed-out welcome modal is a full-viewport, pointer-accepting overlay
 * (`components/WelcomeModal.tsx`, z-index 10000) that covers the app until it
 * is dismissed. It is gated on `welcome_modal_seen` in `localStorage`, which is
 * PER ORIGIN — so a profile that has seen it on production has NOT seen it on a
 * local origin, and the same harness meets a different app depending on where
 * it points. That asymmetry cost a day of diagnosis; seeding the flag makes
 * every origin behave like a returning visitor, which is the state worth
 * measuring.
 */
async function seedReturningVisitor(page) {
    await page.addInitScript(() => {
        try { localStorage.setItem('welcome_modal_seen', 'true'); } catch { /* origin without storage */ }
    });
}

async function openFeed(page) {
    await seedReturningVisitor(page);
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body && document.body.innerText.length > 400, null, { timeout: 45_000 });
    // Shown to a signed-out viewer on the first visit of a profile, and not
    // afterwards, so its absence is normal rather than a failure.
    const interstitial = page.getByText('Explore the app', { exact: false }).first();
    try {
        if (await interstitial.isVisible({ timeout: 3_000 })) await interstitial.click();
    } catch { /* already dismissed for this profile */ }
    await page.waitForTimeout(2_500);
}

/** Signed out there is no BottomBar, so the only way in is the drawer. See README. */
async function openReel(page, target) {
    await page.evaluate(INSTRUMENT);
    await page.mouse.click(36, 28);
    await page.waitForTimeout(900);
    // The hamburger was a click too; only the one that opens the reel counts.
    await page.evaluate(() => { window.__reel.t0 = null; });
    await page.getByText(target, { exact: true }).first().click();
}

async function measure(mode, runs) {
    const target = mode === 'control' ? 'Explore' : 'Videos';
    const timeout = mode === 'control' ? 12_000 : 30_000;
    const browser = await chromium.connectOverCDP(CDP);
    const context = browser.contexts()[0];
    const rows = [];

    for (let i = 0; i < runs; i++) {
        const page = await context.newPage();
        await page.setViewportSize(VIEWPORT);
        await openFeed(page);
        await openReel(page, target);
        try {
            await page.waitForFunction(() => window.__reel?.tFirstFrame !== null, null, { timeout });
        } catch { /* recorded as a miss */ }
        rows.push(await page.evaluate(() => window.__reel));
        await page.close();
    }
    await browser.close();

    const span = (s, from, to) => (s && s[from] !== null && s[to] !== null ? Math.round(s[to] - s[from]) : null);
    console.log(`\n=== mode=${mode}  origin=${ORIGIN}  n=${rows.length} ===`);
    console.log('run | click→route | route→<video> | →metadata | →FIRST FRAME | total click→frame | frames');
    const totals = [];
    rows.forEach((s, i) => {
        const total = span(s, 't0', 'tFirstFrame');
        if (total !== null) totals.push(total);
        const cell = (v, w) => String(v).padStart(w);
        console.log(`${cell(i + 1, 3)} | ${cell(span(s, 't0', 'tRoute'), 11)} | ${cell(span(s, 'tRoute', 'tVideoEl'), 13)} | ${cell(span(s, 'tVideoEl', 'tMeta'), 9)} | ${cell(span(s, 'tMeta', 'tFirstFrame'), 12)} | ${cell(total, 17)} | ${s?.frames ?? '-'}`);
    });

    if (mode === 'control') {
        const clean = totals.length === 0 && rows.every((s) => !s?.frames);
        console.log(clean
            ? '\nCONTROL OK — no frame, no timings. The `open` mode is measuring the reel and not something else.'
            : '\nCONTROL FAILED — a run that never opened the reel still produced a number. Do not trust `open`.');
        return;
    }
    if (totals.length) {
        totals.sort((a, b) => a - b);
        const at = (p) => totals[Math.min(totals.length - 1, Math.floor(p * totals.length))];
        console.log(`\nclick→first frame  min=${totals[0]}ms  median=${at(0.5)}ms  p90=${at(0.9)}ms  max=${totals.at(-1)}ms  (${totals.length}/${rows.length} reached a frame)`);
    } else {
        console.log('\nNo run reached a frame — the flow broke, rather than the app being slow.');
    }
}

async function attribute() {
    const browser = await chromium.connectOverCDP(CDP);
    const page = await browser.contexts()[0].newPage();
    await page.setViewportSize(VIEWPORT);
    await openFeed(page);
    await openReel(page, 'Videos');
    await page.waitForFunction(() => window.__reel?.tFirstFrame !== null, null, { timeout: 30_000 });

    const out = await page.evaluate(() => {
        const { t0, tFirstFrame } = window.__reel;
        return {
            total: Math.round(tFirstFrame - t0),
            rows: performance.getEntriesByType('resource')
                .filter((r) => r.startTime >= t0 - 5 && r.startTime <= tFirstFrame + 5)
                .map((r) => ({
                    start: Math.round(r.startTime - t0),
                    dur: Math.round(r.duration),
                    kind: r.initiatorType,
                    url: r.name.replace(/^https:\/\//, '').slice(0, 62),
                }))
                .sort((a, b) => a.start - b.start),
        };
    });
    console.log(`click→first frame: ${out.total}ms — network inside that window:`);
    console.log('  start   dur  kind        url');
    for (const r of out.rows) {
        console.log(`  ${String(r.start).padStart(5)} ${String(r.dur).padStart(5)}  ${String(r.kind).padEnd(10)}  ${r.url}`);
    }
    await page.close();
    await browser.close();
}


/**
 * Records every PRESENTED frame of every video on the page, tagged with the
 * element's height so a feed card and a fullscreen reel can be told apart
 * afterwards.
 *
 * Chained `requestVideoFrameCallback`, not a poll: the question is whether a
 * frame was ever ABSENT, and a poll can only prove it did not look.
 */
const RECORD_FRAMES = () => {
  const frames = [];
  window.__frames = frames;
  const wire = (v) => {
    if (v.__rec) return;
    v.__rec = true;
    // `where` is what makes the blank locatable: the flying surface lives in
    // Bloom's portal, the feed row and the destination slide do not. Without it
    // a fullscreen frame from the flight and one from the reel are the same
    // reading, and the gap cannot be attributed to either end of the hand-off.
    const where = v.closest('#bloom-portal-root') ? 'flight' : 'route';
    const tick = () => {
      const r = v.getBoundingClientRect();
      frames.push({ t: performance.now(), ct: v.currentTime, h: Math.round(r.height), where, src: (v.currentSrc || '').slice(-24) });
      v.requestVideoFrameCallback(tick);
    };
    v.requestVideoFrameCallback?.(tick);
  };
  const sweep = () => { for (const v of document.querySelectorAll('video')) wire(v); };
  new MutationObserver(sweep).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(sweep, 16);
  sweep();
};

async function continuity(runs) {
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0];
  console.log(`\n=== mode=continuity  origin=${ORIGIN}  post=${POST}  n=${runs} ===`);
  console.log('run | feed ct | reel ct | mono | no new frame | that interval sits between    | verdict');

  for (let i = 0; i < runs; i++) {
    const page = await context.newPage();
    await page.setViewportSize(VIEWPORT);
    await seedReturningVisitor(page);
    await page.goto(`${ORIGIN}/p/${POST}`, { waitUntil: 'domcontentloaded', timeout: 300_000 });
    await page.waitForFunction(() => document.body && document.body.innerText.length > 200, null, { timeout: 300_000 });
    const interstitial = page.getByText('Explore the app', { exact: false }).first();
    try { if (await interstitial.isVisible({ timeout: 3_000 })) await interstitial.click(); } catch { /* not shown */ }

    // The origin surface has to exist before anything can be asked of it.
    await page.waitForSelector('video', { timeout: 90_000 });
    // …and it must actually be PLAYING, or "it did not restart" is vacuous.
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && !v.paused && v.currentTime > 1;
    }, null, { timeout: 60_000 }).catch(() => {});
    await page.evaluate(RECORD_FRAMES);
    await page.waitForTimeout(1_500);

    const before = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? { ct: v.currentTime, playing: !v.paused } : null;
    });

    const box = await page.locator('video').first().boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    // The destination is a video filling the viewport.
    const arrived = await page.waitForFunction(
      () => [...document.querySelectorAll('video')].some((v) => v.getBoundingClientRect().height > innerHeight * 0.6 && v.currentTime > 0),
      null, { timeout: 30_000 },
    ).then(() => true).catch(() => false);
    await page.waitForTimeout(1_200);

    const after = await page.evaluate(() => {
      const v = [...document.querySelectorAll('video')].find((x) => x.getBoundingClientRect().height > innerHeight * 0.6);
      return v ? { ct: v.currentTime, playing: !v.paused } : null;
    });
    const frames = await page.evaluate(() => window.__frames);

    // The gap that matters: last frame painted by ANY small (feed) surface
    // before the first frame painted by a fullscreen one.
    const small = frames.filter((f) => f.h > 0 && f.h < VIEWPORT.height * 0.6);
    const big = frames.filter((f) => f.h >= VIEWPORT.height * 0.6);
    const lastSmall = small.length ? small[small.length - 1] : null;
    const firstBig = big.length ? big[0] : null;
    const gap = lastSmall && firstBig ? Math.round(firstBig.t - lastSmall.t) : null;

    // NOT "was the screen ever blank". This counts intervals in which no VIDEO
    // frame was PRESENTED, and `requestVideoFrameCallback` fires for decoded
    // video and nothing else — a poster is an `<img>` and never triggers it. A
    // flying surface showing a still while its new `<video>` element loads
    // therefore reads here as a gap while the user sees an unbroken picture.
    // Measured on a CDP screencast of exactly such a "gap": no frame was black,
    // luminance moved smoothly 218 -> 99, and the frame in its middle showed
    // the video filling the viewport. Read a number here as "no new decoded
    // frame", and answer "was anything missing" with a screencast.
    // `gap` above is the small→fullscreen crossing, which a flying surface
    // spends the whole animation inside — it measures the travel, not a hole.
    // This measures the hole: the longest interval in which NO element, of any
    // size, presented anything. A steady 30fps video paints every ~33ms, so
    // anything near that is continuous and anything near the crossing time is
    // a real blank.
    const ordered = [...frames].sort((a, b) => a.t - b.t);
    let blank = 0, blankFrom = null, blankTo = null;
    for (let j = 1; j < ordered.length; j++) {
      const d = ordered[j].t - ordered[j - 1].t;
      if (d > blank) { blank = d; blankFrom = ordered[j - 1]; blankTo = ordered[j]; }
    }
    const longestBlank = ordered.length > 1 ? Math.round(blank) : null;
    // Which end of the hand-off the blank sits at, read off the two frames that
    // bracket it rather than inferred from its size.
    const edge = blankFrom && blankTo
      ? `${blankFrom.where}(h${blankFrom.h}) -> ${blankTo.where}(h${blankTo.h})`
      : '-';

    const monotonic = before && after ? after.ct >= before.ct - 0.05 : null;
    const verdict = !arrived ? 'NEVER ARRIVED'
      : monotonic === null ? 'NO READING'
      : monotonic ? 'carried' : 'RESTARTED';
    const cell = (v, w) => String(v).padStart(w);
    console.log(`${cell(i + 1, 3)} | ${cell(before?.ct?.toFixed(2) ?? '-', 8)} | ${cell(after?.ct?.toFixed(2) ?? '-', 7)} | ${cell(monotonic ?? '-', 4)} | ${cell(longestBlank === null ? '-' : longestBlank + 'ms', 13)} | ${String(edge).padEnd(29)} | ${verdict}`);
    await page.close();
  }
  await browser.close();
  console.log('\n"carried" means the reel continued from where the feed was. "RESTARTED" means it went back to zero,');
  console.log('which is what this whole mechanism exists to prevent — and what the code without it does.');
}

/**
 * THE PROPERTY THE CONTINUITY TABLE COULD NOT SEE.
 *
 * `continuity` asks whether a frame was present and whether the position
 * carried. A surface that skipped the animation entirely and appeared at full
 * screen passes both with full marks — measured: it did, and a viewer reported
 * "the video went big and filled the screen" against a table that said the
 * transition was perfect. Presence is not placement.
 *
 * So this judges the SHAPE of the flight from its rect timeline:
 *   1. it starts near the origin thumbnail, not at the destination;
 *   2. it grows without shrinking back;
 *   3. it does not sit at full size for longer than `MAX_SETTLED_MS` before
 *      the destination takes over.
 *
 * Pure on purpose — `evaluateFlightShape` takes a timeline and returns
 * verdicts, so `geometry --selftest` can hand it a FABRICATED jump and prove
 * the assertions fail. A shape check that has never rejected a bad shape is a
 * shape check nobody has tested.
 */
const MAX_SETTLED_MS = 1500;
/** A single frame may not carry more than this much of the whole size change. */
const MAX_STEP_FRACTION = 0.35;

function evaluateFlightShape(timeline, origin, viewport) {
    const seen = timeline.filter((s) => s.rect);
    if (seen.length === 0) return [{ name: 'a surface was painted at all', ok: false, detail: 'no flight rect was ever recorded' }];

    const first = seen[0].rect;
    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    // Generous on size (contentFit letterboxes the media inside the box) and
    // tight on position, which is what "flew from there" actually means.
    const startsAtOrigin = near(first[0], origin[0], 24) && near(first[1], origin[1], 24)
        && first[2] < viewport[0] * 0.75;

    let shrank = 0;
    // Biggest single-frame change in size, as a fraction of the whole journey.
    // Growing monotonically is not enough: a surface can crawl and then LEAP,
    // which is what a `<video>` does when it sits at its default intrinsic size
    // until metadata arrives and then snaps to the real aspect ratio. Measured:
    // 300x150 held for ~80ms, then 402x714 in one frame, at the exact frame
    // `videoWidth` went 0 -> 720. Monotonic the whole way, and visibly a jump.
    let biggestStep = 0, stepAt = null;
    const span = Math.max(1, seen[seen.length - 1].rect[3] - seen[0].rect[3]);
    for (let i = 1; i < seen.length; i++) {
        if (seen[i].rect[2] < seen[i - 1].rect[2] - 2) shrank++;
        const jump = Math.abs(seen[i].rect[3] - seen[i - 1].rect[3]) / span;
        if (jump > biggestStep) { biggestStep = jump; stepAt = Math.round(seen[i].t - seen[0].t); }
    }

    // "Settled" is measured against the surface's OWN final size, never against
    // the viewport. Twice now a threshold derived from the viewport was never
    // reachable — a scrollbar puts innerWidth 15px above where a letterboxed
    // media actually lands — and the rule passed every run without being able
    // to fire. The final rect is a fact of the trace; the viewport is a guess
    // about it.
    const last = seen[seen.length - 1].rect;
    const fullIdx = seen.findIndex((s) => Math.abs(s.rect[2] - last[2]) <= 2 && Math.abs(s.rect[3] - last[3]) <= 2);
    const settledFor = fullIdx === -1 ? null : Math.round(seen[seen.length - 1].t - seen[fullIdx].t);

    return [
        { name: 'starts at the origin thumbnail, not the destination', ok: startsAtOrigin,
          detail: `first rect ${first.join(',')} against anchor ${origin.join(',')}` },
        { name: 'grows without shrinking back', ok: shrank === 0,
          detail: `${shrank} frame(s) narrower than the one before` },
        { name: `sits at full size for under ${MAX_SETTLED_MS}ms`, ok: settledFor === null || settledFor <= MAX_SETTLED_MS,
          detail: settledFor === null ? 'never settled' : `${settledFor}ms at its final size before release` },
        { name: `grows without a step over ${Math.round(MAX_STEP_FRACTION * 100)}% of the journey in one frame`,
          ok: biggestStep <= MAX_STEP_FRACTION,
          detail: `biggest single-frame height change ${Math.round(biggestStep * 100)}%${stepAt === null ? '' : ` at +${stepAt}ms`}` },
    ];
}

/** The control: a timeline that never flew must be rejected by every shape rule that can see it. */
function geometrySelfTest() {
    const viewport = [430, 932];
    const origin = [356, 723, 101, 180];
    const jump = Array.from({ length: 60 }, (_, i) => ({ t: i * 16, rect: [0, 0, 430, 932] }));
    // A SECOND fabricated shape: one that starts at the anchor and grows
    // monotonically, but does the last two thirds of its growth in one frame —
    // the real defect, which every other rule here passes.
    const crawlThenLeap = [
        ...Array.from({ length: 12 }, (_, i) => ({ t: i * 16, rect: [356 - i * 25, 723 - i * 55, 101 + i * 17, 150] })),
        ...Array.from({ length: 12 }, (_, i) => ({ t: (12 + i) * 16, rect: [0, 0, 415, 738] })),
    ];
    const verdicts = evaluateFlightShape(jump, origin, viewport);
    const stepVerdicts = evaluateFlightShape(crawlThenLeap, origin, viewport);
    console.log('SELF-TEST A — a fabricated jump straight to full screen:');
    for (const v of verdicts) console.log(`  ${v.ok ? 'passed' : 'REJECTED'}  ${v.name} — ${v.detail}`);
    console.log('SELF-TEST B — a fabricated crawl that leaps at the end:');
    for (const v of stepVerdicts) console.log(`  ${v.ok ? 'passed' : 'REJECTED'}  ${v.name} — ${v.detail}`);
    const ok = verdicts.some((v) => !v.ok && v.name.startsWith('starts at the origin'))
        && stepVerdicts.some((v) => !v.ok && v.name.startsWith('grows without a step'));
    console.log(ok
        ? '\nCONTROL OK — the jump is caught by the origin rule and the leap by the step rule.'
        : '\nCONTROL FAILED — a fabricated defect satisfied every rule; this mode proves nothing.');
    return ok;
}

async function geometry(runs) {
    if (!geometrySelfTest()) process.exit(1);
    const browser = await chromium.connectOverCDP(CDP);
    const context = browser.contexts()[0];
    console.log(`\n=== mode=geometry  origin=${ORIGIN}  post=${POST}  n=${runs} ===`);

    for (let i = 0; i < runs; i++) {
        const page = await context.newPage();
        await page.setViewportSize(VIEWPORT);
        await seedReturningVisitor(page);
        await page.goto(`${ORIGIN}/p/${POST}`, { waitUntil: 'domcontentloaded', timeout: 300_000 });
        await page.waitForSelector('video', { timeout: 150_000 });
        await page.waitForFunction(() => {
            const v = document.querySelector('video');
            return v && !v.paused && v.currentTime > 1;
        }, null, { timeout: 60_000 }).catch(() => {});
        await page.waitForTimeout(1_200);

        await page.evaluate(() => {
            const samples = [];
            window.__shape = samples;
            const tick = () => {
                const root = document.querySelector('#bloom-portal-root');
                // The MEDIA, never its container: Bloom's OverlayRoot is
                // `position: fixed; inset: 0` by design, so measuring the
                // biggest box in the portal reports every flight as a jump.
                const media = root && (root.querySelector('video') || root.querySelector('img'));
                const r = media ? media.getBoundingClientRect() : null;
                samples.push({ t: performance.now(), rect: r && r.width > 4 ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null });
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });

        const box = await page.locator('video').first().boundingBox();
        const origin = [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)];
        await page.evaluate(() => { window.__shape.length = 0; });
        await page.mouse.click(Math.min(box.x + box.width / 2, VIEWPORT.width - 6), box.y + box.height / 2);
        await page.waitForTimeout(6_000);
        const timeline = await page.evaluate(() => window.__shape);

        // The page's OWN width, not the configured viewport: a scrollbar makes
        // them differ by ~15px, and a "reached full width" threshold derived
        // from the wrong one is never met — the rule then passes every run
        // without ever having been able to fail.
        const inner = await page.evaluate(() => [innerWidth, innerHeight]);
        const verdicts = evaluateFlightShape(timeline, origin, inner);
        const failed = verdicts.filter((v) => !v.ok);
        console.log(`\nrun ${i + 1} — anchor ${origin.join(',')} — ${failed.length === 0 ? 'FLIGHT' : 'NOT A FLIGHT'}`);
        for (const v of verdicts) console.log(`  ${v.ok ? 'ok  ' : 'FAIL'}  ${v.name} — ${v.detail}`);
        await page.close();
    }
    await browser.close();
}

const mode = process.argv[2] ?? 'open';
const runs = Number(process.argv[3] ?? 10);
if (mode === 'attribute') await attribute();
else if (mode === 'geometry') await geometry(runs);
else if (mode === 'continuity') await continuity(runs);
else if (mode === 'open' || mode === 'control') await measure(mode, runs);
else {
    console.error(`unknown mode "${mode}" — expected open, control, attribute, continuity or geometry`);
    process.exit(2);
}
