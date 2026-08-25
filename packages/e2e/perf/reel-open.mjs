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
    const tick = () => {
      const r = v.getBoundingClientRect();
      frames.push({ t: performance.now(), ct: v.currentTime, h: Math.round(r.height), src: (v.currentSrc || '').slice(-24) });
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
  console.log('run | feed ct before | reel ct after | monotonic | biggest frame gap | verdict');

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

    const monotonic = before && after ? after.ct >= before.ct - 0.05 : null;
    const verdict = !arrived ? 'NEVER ARRIVED'
      : monotonic === null ? 'NO READING'
      : monotonic ? 'carried' : 'RESTARTED';
    const cell = (v, w) => String(v).padStart(w);
    console.log(`${cell(i + 1, 3)} | ${cell(before?.ct?.toFixed(2) ?? '-', 14)} | ${cell(after?.ct?.toFixed(2) ?? '-', 13)} | ${cell(monotonic ?? '-', 9)} | ${cell(gap === null ? '-' : gap + 'ms', 17)} | ${verdict}`);
    await page.close();
  }
  await browser.close();
  console.log('\n"carried" means the reel continued from where the feed was. "RESTARTED" means it went back to zero,');
  console.log('which is what this whole mechanism exists to prevent — and what the code without it does.');
}

const mode = process.argv[2] ?? 'open';
const runs = Number(process.argv[3] ?? 10);
if (mode === 'attribute') await attribute();
else if (mode === 'continuity') await continuity(runs);
else if (mode === 'open' || mode === 'control') await measure(mode, runs);
else {
    console.error(`unknown mode "${mode}" — expected open, control, attribute or continuity`);
    process.exit(2);
}
