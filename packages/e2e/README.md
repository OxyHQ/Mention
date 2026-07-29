# @mention/e2e

The browser gate that stands between a built web candidate and production.

It runs inside `.github/workflows/deploy-frontends.yml`, after the curl smoke of
the immutable Cloudflare Pages preview and before the promotion to production. A
failure fails the job while nothing has been promoted, so a broken build is
abandoned rather than rolled back.

## Why a browser at all

The existing `smoke-frontend.sh` proves the deployment answers, serves a hashed
Expo asset and sets the right cache headers. Every boot-time failure this repo
has actually shipped passes all of that:

- a `useTheme()` call outside `<BloomThemeProvider>` throws at mount,
- a boot-mounted component calling `useTranslation()` suspends before i18n
  initialises, so the root render never commits and the page stays white with no
  console output at all,
- a stale route chunk after a deploy makes the host answer `index.html` for a
  missing `*.js`, and the app silently reloads itself.

`AGENTS.md` states in several places that these are visible only in a real,
foregrounded browser and that jest and tsc do not catch them. This package is
that statement, automated.

## Why it browses at `https://mention.earth` and not at the preview URL

Because at the preview URL there is nothing to assert. The production web build
hardcodes `https://api.mention.earth` as its API (`packages/frontend/config.ts`
ignores `EXPO_PUBLIC_API_URL` when `NODE_ENV=production`), and that API answers
every request with a fixed `access-control-allow-origin: https://mention.earth`
(`packages/backend/src/utils/allowedOrigins.ts` allowlists exactly one
production frontend origin). A browser parked on `*.pages.dev` therefore has
every API response blocked by CORS and boots into a permanently empty shell.

Widening the production allowlist to admit preview origins would be a
credentialed-CORS loosening of production, which `AGENTS.md` § CORS explicitly
rules out. So instead the browser runs at the real origin and Playwright serves
every same-origin request from the candidate deployment (`fixtures.ts`). The
document URL, CORS contract, CSP and per-origin storage are production's; the
HTML and every Expo chunk are the candidate's. Requests to `api.mention.earth`
and the media CDN are left alone.

This has one consequence worth stating plainly: the backend the gate exercises
is the live one, so a backend outage will also fail this gate.

That is what `preflight.ts` is for. It runs once before any flow and checks the
backend answers (a `429` counts as not answering — see below), that its
`access-control-allow-origin` still equals the origin the browser is parked on,
and that the candidate deployment is reachable. Any of those failing aborts the
run with `GATE COULD NOT EVALUATE THIS CANDIDATE` and names the dependency at
fault.

The rate-limit case is the one that actually happened rather than the one that
was imagined: running the suite repeatedly from a single address exhausted the
API's 600-requests-per-900-seconds budget, and the flows then failed as
`cold boot did not paint feed rows` — the API was perfectly healthy, it simply
would not serve that caller, so the browser booted into an empty feed. It looks
exactly like a broken candidate and is not one, which is why `429` is treated as
inconclusive and the message carries the `retry-after`. It still fails closed — with the API down there
is no way to tell a safe candidate from a broken one — but it does not let an
unrelated outage surface as "cold boot did not paint feed rows" and send someone
looking through their own diff. A gate that misassigns blame gets switched off
by the first person it blocks.

## Running it locally

```bash
# Against any deployment that is not the live origin.
MENTION_E2E_CANDIDATE_ORIGIN=https://<deployment>.mention-frontend.pages.dev \
  bun run --cwd packages/e2e test

# Or against a local export: bun run build:frontend && npx serve packages/frontend/dist
MENTION_E2E_CANDIDATE_ORIGIN=http://127.0.0.1:3000 bun run --cwd packages/e2e test
```

First run needs the browser: `bun run --cwd packages/e2e install-browser`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MENTION_E2E_CANDIDATE_ORIGIN` | *required* | Deployment holding the build under test |
| `MENTION_E2E_APP_ORIGIN` | `https://mention.earth` | Origin the browser runs at |
| `MENTION_E2E_API_ORIGIN` | `https://api.mention.earth` | Expected canonical ActivityPub actor host |
| `MENTION_E2E_PROFILE_HANDLE` | `nate` | A local handle that exists in production |

There is no default for the candidate origin, and it may not equal the app
origin. Both rules exist so the suite cannot silently degrade into a test of
whatever is already live.

## Coverage, and what is deliberately not here

| # | Flow | What it catches |
| --- | --- | --- |
| 1 | Cold boot of `/` | Provider-ordering crash; suspense deadlock that never commits the root |
| 2 | `/` → `/explore` → `/p/<id>` → back | expo-router async route chunks; the silent `chunkReload.web.ts` recovery reload |
| 3 | `/@<handle>` as a page, and as ActivityPub | `webShell.routes.ts` content negotiation — breaks fediverse discovery while the profile still looks healthy |
| 4 | Search suggestions survive typing and blur; submit carries the full query | The suggestion surface vanishing on the first keystroke or on blur; the stale-closure submit that drops the final character |
| 5 | An image post whose dimensions the feed KNEW settles on ONE layout | The 280x180 fallback box jumping to the real aspect ratio, i.e. media geometry being dropped from the DTO |

Three further flows are planned and are not implemented. They split cleanly by
what each one needs, and the split is the reason they are not all the same size
of job:

- **Flow 4, media bounding boxes.** The regression lock for the image
  crop/pillarbox work — the only automatable check of that geometry. Runs
  anonymously, so it needs no new infrastructure, but it does need *known*
  media: a live feed cannot be relied on to contain a wide image, a tall image,
  a video, a multi-image grid and a wide image inside a quote card on the day
  the gate runs. Pin one production post id per shape and drive `/p/<id>`
  directly (post detail already renders anonymously — flow 2 depends on it),
  reading each rendered box with `boundingBox()` and asserting the aspect the
  fix intends. The dependency is five nominated, stable post ids, not new
  machinery.

- **Flow 5, the Starter Packs search tab and its paging.** Switching to the tab
  and asserting the card count grows past the first page is the pin worth having,
  because paging past the first window used to be structurally impossible. It is
  deferred rather than blocked, and the mechanics are settled — from the author
  of the surface, so it does not need rediscovering:

  * Use `search=art`. It returns 79 packs across 4 pages, with zero overlap
    between pages one and two. `mention` returns nothing and `?search=` fills
    exactly one page, so either would make the test unable to fail. This is the
    detail that had me wrongly call the flow data-blocked.
  * The tab pages by page NUMBER, and `hasMore` is computed client-side as
    `page < totalPages`, driven by FlashList's `onEndReached` at `threshold:
    0.5`. The deterministic trigger is therefore scrolling until the last
    rendered card is reached — not a fixed pixel offset.
  * Assert the card COUNT grew, never that a particular pack appeared: ranking
    is `useCount desc` and can reorder between page fetches.

  What it still needs is a careful pass of its own, because scrolling a
  virtualised list is where flake lives, and this suite would rather be small
  than occasionally wrong.

- **Flow 6, login → compose → assert → delete.** Needs a real test account.
  Whatever secret carries those credentials, the spec must `test.skip` when it
  is absent, so forks and PRs from forks stay green.

Chromium only, on purpose: WebKit doubles both the browser download and the wall
clock of a step sitting directly in front of a production promotion. Add it when
the gate has earned the budget.

The suite is not wired into the PR gate yet. That comes after the promotion gate
has proven itself non-flaky, and the natural hook is CI's existing
`frontend-bundle` job, which already exports `dist/` and could serve it locally.
