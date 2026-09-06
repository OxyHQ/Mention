/**
 * How long a navigation shows NOTHING, measured in a real browser against a
 * real origin — and whether that nothing is the route chunk or the data.
 *
 * NOT a gate and deliberately not under `tests/`: it prints numbers and never
 * fails, so Playwright's `testDir` must never discover it. Read `README.md` in
 * this directory before trusting a number out of it.
 *
 *   node nav-latency.mjs selftest      # markers match on a direct load; refuses to measure if not
 *   node nav-latency.mjs control  [n]  # activate something that does NOT navigate; must be all nulls
 *   node nav-latency.mjs post     [n]  # feed row -> /p/<id>
 *   node nav-latency.mjs hot      [n]  # the SECOND such navigation in one page, module already evaluated
 *
 *   CDP=http://127.0.0.1:39871  ORIGIN=https://mention.earth  VW=430 VH=932
 *
 * ## Why five timestamps and not "how long did it take"
 *
 * Swapping a spinner for a skeleton does not move "first real content" by one
 * millisecond, and swapping a blank frame for a skeleton does not move it
 * either. Reporting one number would make half the work invisible. So:
 *
 *   t0      the activation itself, from the event, in the CAPTURE phase
 *   tRoute  the URL changed
 *   tShell  the destination painted ANYTHING of its own (skeleton counts)
 *   tFMP    the destination painted REAL content (a skeleton cannot satisfy it)
 *
 *   blankMs   = tShell - tRoute   the frame where the app shows nothing
 *   contentMs = tFMP   - tShell   how long the skeleton is up
 *
 * `chunkMs` is the attribution column and the reason this exists: if the route
 * chunk is fetched inside the blank window, the blank frame is the chunk and
 * warming it fixes it. If it is not, the blank frame is data and chunk warming
 * would be a fix for a problem nobody has.
 */
import { chromium } from '@playwright/test';

const CDP = process.env.CDP ?? 'http://127.0.0.1:39871';
const ORIGIN = process.env.ORIGIN ?? 'https://mention.earth';
const VIEWPORT = { width: Number(process.env.VW ?? 430), height: Number(process.env.VH ?? 932) };

/**
 * Runs in the page BEFORE the activation.
 *
 * `t0` comes from the event in the capture phase, never from the driver's call
 * into the page: the CDP round trip is tens of milliseconds and would land
 * inside the number being reported.
 *
 * `tRoute` needs three sources because the app is an SPA with no `<a href>`:
 * `pushState` and `replaceState` are patched, `popstate` is listened for, and a
 * 16 ms poll catches anything that changes `location` by another route. The
 * poll alone would be enough but would quantise the number to a frame.
 *
 * `tShell` and `tFMP` are sampled from the same rAF loop, so they are ordered
 * by construction and cannot cross.
 */
const INSTRUMENT = ({ pathPattern, marker }) => {
    window.__nav = {
        t0: null, tRoute: null, tShell: null, tFMP: null,
        pathAtRoute: null, sawSkeleton: false,
    };
    const nav = window.__nav;
    const re = new RegExp(pathPattern);

    const mark = (event) => {
        if (nav.t0 !== null) return;
        if (event.type === 'keydown' && event.key !== 'Enter') return;
        nav.t0 = performance.now();
    };
    addEventListener('click', mark, true);
    addEventListener('keydown', mark, true);

    const seeRoute = () => {
        if (nav.tRoute !== null || nav.t0 === null) return;
        if (!re.test(location.pathname)) return;
        nav.tRoute = performance.now();
        nav.pathAtRoute = location.pathname;
    };
    for (const name of ['pushState', 'replaceState']) {
        const original = history[name];
        history[name] = function patched(...args) {
            const result = original.apply(this, args);
            seeRoute();
            return result;
        };
    }
    addEventListener('popstate', seeRoute);
    setInterval(seeRoute, 16);

    // A skeleton is the destination painting something of its own, which is a
    // DIFFERENT fact from painting content — and the only way to tell a blank
    // frame from a slow fetch apart.
    const hasSkeleton = () => document.querySelector('[role="progressbar"]') !== null;
    const hasContent = () => {
        for (const element of document.querySelectorAll('[aria-label]')) {
            if (element.getAttribute('aria-label') === marker) return true;
        }
        return false;
    };

    // Whether the wait is the main thread WORKING or the main thread WAITING.
    // No `PerformanceResourceTiming` can tell those apart, and they have
    // completely different fixes: one is a render to break up, the other is a
    // fetch to start earlier.
    nav.longTasks = [];
    try {
        new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                if (nav.t0 === null) continue;
                nav.longTasks.push({
                    start: Math.round(entry.startTime - nav.t0),
                    duration: Math.round(entry.duration),
                });
            }
        }).observe({ type: 'longtask', buffered: true });
    } catch { /* browser without the longtask entry type */ }

    // Frame cadence through the wait. Zero long tasks can mean two things — an
    // idle thread, or work chopped below the 50 ms longtask threshold — and rAF
    // separates them: a busy thread cannot deliver 60 frames a second.
    nav.frames = [];
    nav.census = [];
    // Name the waiter. The thread is idle and no request is outstanding, so
    // whatever holds the screen blank is a SCHEDULED callback; this records the
    // delay it asked for and where it was asked from.
    nav.timers = [];
    const originalSetTimeout = window.setTimeout;
    window.setTimeout = function patchedSetTimeout(handler, delay, ...rest) {
        if (nav.t0 !== null && nav.tFMP === null && (delay ?? 0) >= 60) {
            const site = (new Error().stack ?? '').split('\n').slice(2, 4).join(' | ');
            nav.timers.push({ at: Math.round(performance.now() - nav.t0), delay, site });
        }
        return originalSetTimeout.call(this, handler, delay, ...rest);
    };
    const sample = () => {
        if (nav.tRoute !== null && nav.tFMP === null) {
            nav.frames.push(Math.round(performance.now() - nav.tRoute));
            // What the DOM is doing while the thread is idle. A tree that is
            // torn down at once and rebuilt at once, with nothing in between,
            // is a WAIT; a tree that grows frame by frame is chopped work.
            nav.census.push({
                at: Math.round(performance.now() - nav.tRoute),
                rows: document.querySelectorAll('[data-post-uri]').length,
                labels: document.querySelectorAll('[aria-label]').length,
                text: document.body ? document.body.innerText.length : 0,
            });
            const content = hasContent();
            if (nav.tShell === null && (content || hasSkeleton())) {
                nav.tShell = performance.now();
                nav.sawSkeleton = !content;
            }
            if (content) nav.tFMP = performance.now();
        }
        requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
};

/**
 * What the browser fetched after the activation — the attribution columns.
 *
 * Two kinds, and telling them apart is the whole point: a route CHUNK inside the
 * blank window means the blank frame is code and warming it fixes it; an API
 * call inside it means the blank frame is data and warming a chunk would be a
 * fix for a problem nobody has. Neither means the wait is module evaluation and
 * render, which no `PerformanceResourceTiming` can see.
 */
const READ_TRANSFERS = () => {
    const t0 = window.__nav?.t0 ?? 0;
    const after = performance.getEntriesByType('resource').filter((entry) => entry.startTime >= t0);
    const shape = (entry) => ({
        name: entry.name.split('/').slice(-1)[0].split('?')[0],
        start: Math.round(entry.startTime - t0),
        end: Math.round(entry.responseEnd - t0),
        transferred: entry.transferSize,
    });
    return {
        chunks: after.filter((entry) => entry.name.includes('/_expo/static/js/web/')).map(shape),
        api: after
            .filter((entry) => /api\.(mention\.earth|oxy\.so)/.test(entry.name))
            .map((entry) => ({ ...shape(entry), path: new URL(entry.name).pathname })),
    };
};

/**
 * The signed-out welcome modal is a full-viewport, pointer-accepting overlay
 * that covers the app until dismissed, gated on `welcome_modal_seen` in
 * `localStorage` PER ORIGIN. Seeding it makes every run a returning visitor,
 * which is the state worth measuring.
 */
async function openFeed(page) {
    await page.addInitScript(() => {
        try { localStorage.setItem('welcome_modal_seen', 'true'); } catch { /* origin without storage */ }
    });
    await page.setViewportSize(VIEWPORT);
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-post-uri]', { timeout: 60_000 });
    const interstitial = page.getByText('Explore the app', { exact: false }).first();
    try {
        if (await interstitial.isVisible({ timeout: 2_000 })) await interstitial.click();
    } catch { /* not shown for a returning visitor */ }
    await page.waitForTimeout(1_500);
}

/**
 * The label of the row about to be opened, which becomes the destination's FMP
 * marker.
 *
 * `PostItem` sets `accessibilityLabel` to `${author}: ${text summary}`, so it is
 * parameterised by the post's own identity: a stale render or a wrong-destination
 * run cannot satisfy it. On web `(app)/_layout.tsx` renders a bare `<Slot/>`, so
 * the feed UNMOUNTS on navigation and the only element carrying this label after
 * `tRoute` is the focused post on the detail screen.
 */
async function pickRow(page, index) {
    return page.evaluate((rowIndex) => {
        const rows = [...document.querySelectorAll('[data-post-uri]')];
        const row = rows[rowIndex];
        if (!row) return null;
        const labelled = row.matches('[aria-label]') ? row : row.querySelector('[aria-label]');
        const focusable = row.matches('[tabindex]') ? row : row.querySelector('[tabindex]');
        if (!labelled || !focusable) return null;
        return { label: labelled.getAttribute('aria-label'), uri: row.getAttribute('data-post-uri') };
    }, index);
}

/**
 * mention.earth renders ZERO `<a href>` — every row is an RNW `Pressable`, and a
 * real mouse click on a row lands on an inner `IMG` and does nothing at all
 * (`isTrusted: true`, `defaultPrevented: false`, and the path never changes), so
 * it reads as a dead app rather than a missed target. Keyboard activation is
 * what works.
 */
async function activateRow(page, index) {
    await page.evaluate((rowIndex) => {
        const rows = [...document.querySelectorAll('[data-post-uri]')];
        const row = rows[rowIndex];
        const focusable = row?.matches('[tabindex]') ? row : row?.querySelector('[tabindex]');
        focusable?.focus();
    }, index);
    await page.keyboard.press('Enter');
}

function percentile(values, fraction) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function summarise(label, values) {
    const present = values.filter((value) => value !== null && Number.isFinite(value));
    if (present.length === 0) return `${label.padEnd(11)} —      (0/${values.length})`;
    return `${label.padEnd(11)} p50 ${String(Math.round(percentile(present, 0.5))).padStart(5)}`
        + `   p90 ${String(Math.round(percentile(present, 0.9))).padStart(5)}`
        + `   (${present.length}/${values.length})`;
}

const POST_PATH = '^/p/';

async function run(mode, runs) {
    const browser = await chromium.connectOverCDP(CDP);
    const context = browser.contexts()[0];
    const rows = [];

    for (let attempt = 0; attempt < runs; attempt += 1) {
        const page = await context.newPage();
        try {
            await openFeed(page);
            const row = await pickRow(page, 0);
            if (!row) throw new Error('no feed row carried both an aria-label and a tabindex');

            await page.evaluate(INSTRUMENT, { pathPattern: POST_PATH, marker: row.label });

            if (mode === 'hot') {
                // Navigate once and come back, so the route module is already
                // registered. If the wait survives that, it is not module
                // resolution — it is whatever the shell does on every commit.
                await activateRow(page, 0);
                await page.waitForFunction(() => window.__nav?.tFMP !== null, null, { timeout: 25_000 })
                    .catch(() => undefined);
                await page.goBack({ waitUntil: 'domcontentloaded' });
                await page.waitForSelector('[data-post-uri]', { timeout: 30_000 });
                await page.waitForTimeout(1_000);
                const second = await pickRow(page, 1);
                if (!second) throw new Error('no second feed row after going back');
                await page.evaluate(INSTRUMENT, { pathPattern: POST_PATH, marker: second.label });
                await activateRow(page, 1);
                await page.waitForFunction(() => window.__nav?.tFMP !== null, null, { timeout: 25_000 })
                    .catch(() => undefined);
                await page.waitForTimeout(300);
            } else if (mode === 'control') {
                // Activate something that must NOT reach `/p/`. If this produces a
                // number, every number in `post` is meaningless.
                await page.keyboard.press('Tab');
                await page.waitForTimeout(4_000);
            } else {
                await activateRow(page, 0);
                try {
                    await page.waitForFunction(() => window.__nav?.tFMP !== null, null, { timeout: 25_000 });
                } catch { /* recorded as a miss, not thrown */ }
                await page.waitForTimeout(500);
            }

            const nav = await page.evaluate(() => window.__nav);
            const transfers = await page.evaluate(READ_TRANSFERS);
            rows.push({ ...nav, ...transfers, uri: row.uri });
        } catch (error) {
            rows.push({ error: String(error), t0: null, tRoute: null, tShell: null, tFMP: null, chunks: [], api: [] });
        } finally {
            await page.close();
        }
    }

    report(mode, rows);
    process.exit(0);
}

function report(mode, rows) {
    const delta = (a, b) => rows.map((row) => (row[a] !== null && row[b] !== null ? row[a] - row[b] : null));

    console.log(`\n=== nav-latency  mode=${mode}  origin=${ORIGIN}  viewport=${VIEWPORT.width}x${VIEWPORT.height}  n=${rows.length} ===\n`);
    console.log(summarise('t0→route', delta('tRoute', 't0')));
    console.log(summarise('blankMs', delta('tShell', 'tRoute')));
    console.log(summarise('contentMs', delta('tFMP', 'tShell')));
    console.log(summarise('t0→FMP', delta('tFMP', 't0')));

    const skeletons = rows.filter((row) => row.sawSkeleton).length;
    console.log(`\nskeleton observed before content: ${skeletons}/${rows.length}`
        + (skeletons === 0 ? '   <- NO SKELETON OBSERVED: tShell == tFMP, blankMs is the whole wait' : ''));

    // One representative run in full, then the aggregate: ten identical listings
    // are noise, and the question is which KIND of transfer sits in the window.
    const sample = rows.find((row) => !row.error) ?? rows[0];
    console.log('\nattribution — run 0, everything fetched after activation:');
    for (const chunk of sample?.chunks ?? []) {
        console.log(`  chunk  ${chunk.name.padEnd(52)} +${chunk.start}ms → +${chunk.end}ms  ${chunk.transferred}B`);
    }
    for (const call of sample?.api ?? []) {
        console.log(`  api    ${call.path.padEnd(52)} +${call.start}ms → +${call.end}ms  ${call.transferred}B`);
    }
    if ((sample?.chunks.length ?? 0) + (sample?.api.length ?? 0) === 0) console.log('  none');

    const inBlankWindow = (row, entries) => entries.filter(
        (entry) => row.tShell !== null && row.t0 !== null && entry.end <= row.tShell - row.t0,
    ).length;
    const chunkHits = rows.filter((row) => !row.error && inBlankWindow(row, row.chunks) > 0).length;
    const apiHits = rows.filter((row) => !row.error && inBlankWindow(row, row.api) > 0).length;
    console.log(`\nruns whose blank window contains a route chunk: ${chunkHits}/${rows.length}`);
    console.log(`runs whose blank window contains an API call:   ${apiHits}/${rows.length}`);

    const blocked = rows.map((row) => (row.longTasks ?? []).reduce((total, task) => total + task.duration, 0));
    console.log(`\nmain thread BLOCKED after activation: ${summarise('longtask', blocked).slice(11)}`);
    console.log('  run 0 long tasks: ' + ((sample?.longTasks ?? []).map((task) => `+${task.start}ms for ${task.duration}ms`).join(', ') || 'none'));

    const gaps = (frames) => frames.slice(1).map((value, index) => value - frames[index]);
    const frameCounts = rows.map((row) => (row.frames ?? []).length);
    const maxGaps = rows.map((row) => Math.max(0, ...gaps(row.frames ?? [])));
    console.log(`\nrAF frames delivered during the blank window: ${summarise('frames', frameCounts).slice(11)}`);
    console.log(`largest gap between two frames:              ${summarise('gap', maxGaps).slice(11)}`);
    console.log('\ntimers >= 60ms scheduled during the wait (run 0):');
    for (const timer of (sample?.timers ?? []).slice(0, 12)) {
        console.log(`  +${timer.at}ms  delay=${timer.delay}  ${timer.site}`);
    }
    if ((sample?.timers ?? []).length === 0) console.log('  none');

    console.log('\nDOM through the blank window (run 0) — ms after tRoute: rows/aria-labels/textlen');
    console.log('  ' + (sample?.census ?? [])
        .map((point) => `${point.at}:${point.rows}/${point.labels}/${point.text}`)
        .join('  '));
    console.log('');
}

async function selftest() {
    const browser = await chromium.connectOverCDP(CDP);
    const page = await browser.contexts()[0].newPage();
    await openFeed(page);
    const row = await pickRow(page, 0);
    console.log(`\nfeed row addressable:      ${row ? 'yes' : 'NO — harness refuses to measure'}`);
    if (!row) process.exit(1);
    console.log(`  aria-label:              ${JSON.stringify(row.label)}`);
    console.log(`  data-post-uri:           ${row.uri}`);

    // The marker has to hold on a DIRECT load of the destination too, otherwise a
    // fast number and a probe that never fired are the same output.
    const id = row.uri.split('/').pop();
    await page.goto(`${ORIGIN}/p/${id}`, { waitUntil: 'domcontentloaded' });
    const found = await page.waitForFunction((marker) => {
        for (const element of document.querySelectorAll('[aria-label]')) {
            if (element.getAttribute('aria-label') === marker) return true;
        }
        return false;
    }, row.label, { timeout: 30_000 }).then(() => true).catch(() => false);
    console.log(`  marker on a direct load: ${found ? 'yes' : 'NO — the FMP marker is wrong'}`);

    const skeleton = await page.evaluate(() => document.querySelectorAll('[role="progressbar"]').length);
    console.log(`  progressbar elements now: ${skeleton}`);
    await page.close();
    process.exit(found ? 0 : 1);
}

const [, , mode = 'selftest', runsArgument] = process.argv;
const runs = Number(runsArgument ?? 10);
if (mode === 'selftest') await selftest();
else await run(mode, runs);
