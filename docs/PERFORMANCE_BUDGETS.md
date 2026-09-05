# Performance budgets

**Scope of this document, stated up front:** issue #703 asked for SLOs and
regression budgets across a long list of backend and client paths. This
document is deliberately narrower than that list. An SLO nobody measures is
worse than none — it looks like a commitment while giving the team nothing
to hold it against — so this covers exactly the paths that have a real
measurement pipeline BEHIND them today, and says plainly, for every other
path in the original ask, what instrumentation exists and what is still
missing before a numeric budget would mean anything.

## What is measured and enforced today

### Client JS/web bundle size

`packages/frontend/bundle-budgets.json` is a real, CI-enforced regression
budget — `packages/frontend/scripts/analyze-bundle.js --ci` fails the build
past any of:

| Budget | Ceiling |
| --- | --- |
| Total bytes | 18 MiB |
| JavaScript bytes | 13 MiB |
| Initial JavaScript bytes | 8.5 MiB |
| Initial JavaScript gzip bytes | ~2.35 MiB (target: ~1.9 MiB) |
| Font bytes | 4 MiB |
| Largest single file | 7.5 MiB |

Wired into `.github/workflows/ci.yml`'s "Enforce bundle budgets" step, which
also diffs the PR's export against `main`'s baseline. This is the one item
on the original SLO list that already has the property the rest of this
document argues for: a number, a place it is measured, and a build that
fails when the number is exceeded.

### Real-browser release gate

`packages/e2e` drives the candidate web build at the production origin
before promotion — see `packages/e2e/README.md`. It is a correctness gate
(cold-boot deadlocks, auth races, search regressions), not a latency budget:
it does not currently assert on timing. Worth knowing before assuming
"there's an e2e gate" implies "there's a performance gate."

## What is instrumented but not held to a budget

`packages/backend/src/utils/metrics.ts` defines a real `prom-client`
registry — `http_request_duration_ms` (histogram, labeled by method/route/
status), `feed_ranking_duration_ms`, and real-user `web_vital_lcp_ms` /
`web_vital_inp_ms` / `web_vital_cls_ratio` histograms (fed by
`routes/webTelemetry.routes.ts`) all exist and are computed correctly today.
`routes/internalMetrics.routes.ts` exposes them in Prometheus text format,
IP-allowlisted and token-gated.

### Where a request's time goes: Postgres, or Oxy

Two instrumentations answer the question `http_request_duration_ms` cannot —
*what* a slow route was slow doing. Both attach at a single seam and both
report per request, on the `HTTP request completed` log line that
`middleware/requestObservability.ts` emits:

| Field | Source | Reads |
| --- | --- | --- |
| `queryCount` / `queryDurationMs` | `db/queryMetrics.ts` | Postgres statements issued and time inside them |
| `oxyCallCount` / `oxyDurationMs` | `utils/oxyMetrics.ts` | Oxy API calls issued and time waiting on them |

`slowQueryCount` / `failedQueryCount` and `failedOxyCallCount` sit beside them.
The matching histograms — `db_request_queries`, `db_request_duration_ms`,
`oxy_request_calls`, `oxy_request_duration_ms`, plus per-call
`oxy_call_duration_ms` and `oxy_calls_total` by templated route — are in the
registry too, but **the log line is the one that survives the process**, for
the reason immediately below.

Read them together. `postHydrationStatementBudget.test.ts` pins one hydration
at seven statements whether it hydrates one post or twenty, so a route that is
slow with a small `queryCount` is slow somewhere else, and `oxyCallCount` is
where to look first: `PostHydrationService.buildViewerContext` resolves the
viewer's blocked, restricted, following and follower sets live for any caller
that does not thread a pre-resolved `viewerGraph` — which the feed path does
and post detail, notifications, profile and search do not.

**No baseline numbers are recorded here yet.** The instrumentation exists; a
number belongs in this document only once someone has read it off a real
deployment, and one written from a code trace would be a guess wearing a
measurement's clothes. `OXY_REQUEST_METRICS_ENABLED=false` takes the Oxy half
out of the path entirely (no wrapper, no async context), the same posture as
`DB_QUERY_METRICS_ENABLED`.

**Nothing scrapes it.** There is no Prometheus, Grafana, or CloudWatch
metrics pipeline for Mention in `oxy-infra/terraform-uswest2` (checked
directly, not inferred) — `/internal/metrics` is a live snapshot an operator
can `curl` by hand, not a time series anything retains. That means:

- No p50/p95/p99 for any backend path survives past the current process.
- No dashboard, no alert, and no way to answer "did this regress since last
  week" from data — only "what is it right now."
- A numeric SLO written against `http_request_duration_ms` today would be a
  budget nothing enforces, which is the exact failure mode this document
  opens by naming.

This covers every backend path #703 asked for (following/For You/profile
feed, search, post create/update, notifications, ActivityPub inbox and
delivery-queue age, websocket propagation, background worker queue age) in
the sense that request-level latency for anything routed through Express is
already in `http_request_duration_ms` by route label, and feed ranking has
its own histogram. The gap is uniformly the pipeline, not per-path
instrumentation — fixing it once (standing up scraping + retention for
`/internal/metrics`) unlocks a budget for all of them at once, rather than
needing a bespoke solution per path.

### Web navigation latency

`packages/e2e/perf/nav-latency.mjs` measures how long the app is blank after a
tap, and attributes it. Like `reel-open.mjs` it is a measurement, not a gate:
it prints numbers and never fails.

Measured 2026-09-05 against production, real Chrome on a private Xvfb, signed
out, warm cache, fresh page per run, n=10 (mobile) / n=6 (desktop):

| feed row → `/p/<id>` | cold (first of the session) | hot (second, same page) |
| --- | --- | --- |
| blank frame, p50 | **315 ms** (430x932) / 310 ms (1440x900) | **1 ms** / 2 ms |
| tap → real content, p50 | 332 ms / 321 ms | **13 ms** / 16 ms |

The attribution matters more than the totals: the route chunk is fetched in
**1 ms** from disk cache, **no API call completes inside the blank window**
(the screen paints from the in-memory post cache before `/feed/item/` even
starts), there are **zero long tasks**, and rAF delivers 20 frames at a regular
17 ms cadence through the wait. The main thread is idle and the network is
done — the wait is the first-time resolution of the route module, and the `hot`
column is both the proof and the ceiling.

Absolute numbers here belong to one machine and one network; they are
meaningful against another run of the same harness on the same setup, and
nowhere else.

## What has no instrumentation at all

Feed scroll memory behavior after a large number of posts, image/media
loading regressions, and cold-start / first-usable-screen timing on native
(iOS/Android) have no measurement of any kind in this repository today —
not "uncollected," genuinely absent. Web LCP is covered by the real-user web
vitals above; native cold start is not.

## Recommended next step, not taken in this pass

Wire `/internal/metrics` into a retained time series (CloudWatch embedded
metric format from the existing ECS tasks is the lowest-new-infrastructure
option, since Mention already runs there — see `oxy-infra`). That is an
infrastructure decision for `oxy-infra`'s own owners, not a Mention code
change, and is why it is a recommendation here rather than a PR. Once a
metric survives longer than the process that emitted it, come back and
write a real p95/p99 number against it — a number chosen before that lands
would be a guess wearing an SLO's clothes.
