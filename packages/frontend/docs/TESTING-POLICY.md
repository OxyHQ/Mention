# Frontend testing policy

What the coverage gate asserts, why it is shaped this way, and what to do when
it stops you. The machinery is `scripts/coverage-policy.mjs`, configured by
`coverage-policy.json` (hand-curated) and `coverage-baseline.json`
(machine-recorded).

## The two commands

```bash
bun run --cwd packages/frontend test:coverage    # writes coverage/coverage-summary.json
bun run --cwd packages/frontend coverage:check   # evaluates the policy against it
```

CI runs exactly these, in that order, in the `Test frontend` leg. Every failure
message ends with the pair above, so a red check is reproducible without reading
the workflow.

When the gate asks for it:

```bash
bun run --cwd packages/frontend coverage:record               # pin new logic files
bun run --cwd packages/frontend coverage:record -- --refresh  # re-anchor every number
```

Plain `coverage:record` only adds pins for newly classified files and drops
pins for files that left the domains; every other number stays byte-identical,
so two changes that each add a file do not conflict in the merge queue.
`--refresh` re-anchors the totals, pins and file sizes at the current
measurement. A pull request does not need it: when the baseline has gone stale,
the daily `coverage-reanchor` workflow re-anchors `main` and merges that through
the queue, so pull requests never conflict over it. A change that only deletes
code or only adds tests needs neither. Commit the
baseline in the same change. Whatever is written is checked against the base
revision's baseline, and a looser one fails — that is the check the ratchet
rests on.

## Published Bloom source in Jest

The Expo resolver selects Bloom's public `react-native` export condition, so
entries such as `@oxy.so/bloom/grid` resolve to TypeScript source inside the
installed Bloom package. Jest therefore allows `@oxy.so/bloom` through the existing
Expo Babel transform instead of ignoring it as an already compiled dependency.
Keep the rest of the Expo transform exclusions intact. Run these gates against
the installed registry package; a source mirror outside `node_modules` can hide
a missing transform allowlist entry. This preserves real component execution
without replacing Bloom with test mocks.

## Lazy HLS decoder in Jest

`lib/hlsPlayback.web.ts` uses the normal Expo/Jest transform plus the existing
promise-based dynamic-import transform used by the row-cost harness. This narrow
Jest override lets its real lifecycle and playback-controller code execute while
[hls.js](https://github.com/video-dev/hls.js) is mocked at the external decoder boundary. Production keeps Metro's
lazy chunk unchanged. Tests assert loading demand, buffer-preserving resume,
source/player changes, fatal fallback, cancelled imports and cleanup; Playwright
separately verifies actual decoded frames.

## Why not just raise the global number

Measured on `c96c2764`, before this policy existed: `package.json` declared a
global floor of **14.86% statements** while the suite actually produced
**28.34%**. Thirteen and a half points of slack — enough to delete every test in
`stores/` and `services/` and still report green. The floor had never failed
because it could not.

Raising that number alone would not have fixed it either. A global percentage is
satisfied by whatever is cheapest to cover, and the cheapest thing to cover is
never the code that matters: a render test over a presentational row covers
hundreds of statements while asserting nothing anyone depends on. So the policy
names the code instead, and the global number is only the outermost of five
nets.

## What the policy asserts

**1. Domains.** Glob sets over the behavioural-logic tree — `stores/`,
`services/`, `lib/` (minus `lib/animations/`), `db/`, `components/providers/`,
`hooks/`, `utils/`. 238 files today. `components/` is otherwise absent on
purpose: that is the boilerplate/behaviour line the policy draws.

**2. Classification completeness.** Every file a domain glob matches must be
either pinned in the baseline or written down in `unenforceable` with a reason.
A file in neither **fails**. This is what a hand-maintained list cannot do — a
new service is inside the gate the moment it is written, rather than whenever
somebody remembers to add it.

**3. Per-file pins.** Each classified file carries its measured covered/total
**counts**, held to the rule in 5 from its own anchor. So a pin catches the one
thing an aggregate hides: a single critical file losing its tests while the
total is held up elsewhere. Deleting `services/__tests__/followGraph.test.ts`
moves the global number by 0.02 points — under every global floor, past every
jest threshold — and turns every statement in the file uncovered with nothing
added, which its pin refuses. Deleting code from a pinned file never trips it;
code added to it must be covered at least as well as the file already was.

**4. The critical-path bar: 80% statements, 65% branches.** Applied to the seven
areas issue #700 names:

| area                                          | files | clear the bar |
| --------------------------------------------- | ----- | ------------- |
| authentication, session and account switching | 4     | 3             |
| composer and post mutations                   | 7     | 1             |
| React Query cache keys and invalidation       | 6     | 6             |
| permissions and channel management            | 4     | 3             |
| federation-facing UI state                    | 4     | 1             |
| deep links and share intents                  | 3     | 1             |
| feed pagination and state restoration         | 9     | 8             |

Branches are held higher relative to reality than statements on purpose: a
permission check, a consent gate and a cursor boundary are all branches, and a
test that walks the happy path covers every statement in them.

The sixteen files that do not clear it are in `belowBarExemptions`, each with a
reason and a date. That list is the honest half of the policy — it says out loud
which named-critical code is untested instead of lowering the bar until
everything passes. It carries an **exact** count, not a maximum, so it cannot
grow one defensible line at a time; and an entry that starts clearing the bar is
reported as a failure until it is deleted.

**5. The ratchet: added code at the average, nothing covered lost.** Per metric
(statements, branches, functions, lines), from a recorded anchor of C covered
out of T items (U = T − C uncovered), with G items **added** since, the code may
now have at most U + G·U/T uncovered items:

- code added since may be uncovered at the anchor's own rate — new code must be
  covered at least as well as the average, the rule this gate has always had;
- nothing that was covered may become uncovered;
- deleting code adds nothing, so deleting tested code can never fail.

It is compared exactly, as integers: uncovered·T ≤ U·T + G·U. Nothing rounds.
For a pin, G is that file's growth. For the whole report, G is the sum of each
file's growth — max(0, now − anchor) per file, from the `sizes` the baseline
records — never the net change of the total (see below for why).

Falling more than `uncoveredSlackAllowance` items inside the limit (about 0.75
points of each metric, the percentage allowance it replaced) means the baseline
is stale — without a refresh, tests added today could be deleted next month
unnoticed. CI only warns about it; `.github/workflows/coverage-reanchor.yml`
runs the check on `main` once a day with the warning turned into a failure, and
when it fails runs `coverage:record -- --refresh`, re-checks, and opens an
auto-merging pull request (`autobump/coverage-baseline`).

**6. The baseline may not relax against the base revision.** Every other check
reads the committed baseline, so without this one a pull request could record a
looser baseline in the same commit that removes the tests and pass all of them.
The committed numbers are held to the same rule as a measurement: they must be
reachable from the base revision's by adding code at its rate and deleting code.
Re-anchoring a tree that passes the check therefore always passes here. Anything
looser needs a dated, path-and-metric-named entry in `allowedBaselineRelaxations`
(`path` is a pinned file or `total`). Only entries the change itself **adds**
(absent from the base revision's policy) excuse a relaxation, and an added entry
with no matching relaxation fails, so the list cannot become a standing
permission slip. An entry that merged earlier is inherited: it excuses nothing
and is checked for nothing, so the next pull request in the queue does not fail
on it and nobody has to come back and delete it. Deleting code never needs an
entry.

## Why counts, and why growth is summed per file

Until schema 2 of `coverage-baseline.json` the ratchet and the pins compared
percentages — the totals at two decimals with zero allowed drop, the pins floored
to whole points — and both failed good changes:

- **Deleting tested code lowered every ratio under 100%** though nothing became
  less tested. #1814 removed one tested function and failed with "functions
  coverage fell to 50.87% from 50.88%"; 23 `allowedBaselineDecreases` entries in
  three days were almost all this, written to excuse deletions.
- **The merge queue failed changes at random.** Two changes that each passed
  alone could cross a 0.01 step together, and whichever crossed it was ejected.
- **Every re-record rewrote the whole `total` block**, so any two queued changes
  that re-recorded conflicted, and one was ejected.

The rule above keeps what the percentage meant for added code and drops what it
did to deleted code, and it is exact, so nothing crosses a rounding step.

Growth is summed per file because a net-growth rule — G = max(0, T_now − T) for
the whole report — lets a deletion in one file cancel the allowance an addition
in another earned. Measured against this repository's functions baseline: one
merged change adds 20 functions at 55% covered (above the 50.9% average) and
passes; the next change only deletes 5 tested functions, and a net rule fails it.
In the queue, a change deleting 10 tested functions and a change adding 10 at
60% each pass alone and fail together under a net rule. Summed per file, both
pass; `coverage:policy-selftest` holds each case, and replacing the per-file sum
with the net change turns exactly those two red.

What still does not compose:

- **Two queued changes to the same file**, one deleting and one adding, net
  inside that file. Rare, and visible in the file list.
- **Banked slack.** A change whose additions are covered worse than the average
  passes only while earlier changes left room inside the limit, and two such
  changes queued together can overspend it. A change whose additions are
  covered at least as well as the average cannot be failed by what else is in
  the queue.
- **The stale-baseline check.** Two queued changes that each add tests can bank
  more than the allowance together, and two pull requests that each re-anchor
  conflict, so CI only warns (`COVERAGE_POLICY_STALE_BASELINE=warn` in `ci.yml`)
  and `coverage-reanchor.yml` re-anchors `main`.

The critical-path bar (rule 4) stays a percentage on purpose: it is a fixed
floor, not a ratchet, and "80% of this file is tested" is the claim it makes.

The migration from schema 1 is checked, not trusted: a base revision whose
baseline predates schema 2 has its exact totals used as the anchor (growth
falling back to the net change, since it recorded no sizes), and each percentage
pin becomes the minimum covered count it required at the current size, so the
converting change could not record a looser gate than the one it replaced.

**7. The pre-existing jest thresholds stay.** `lib/viewerQueryKeys.ts` at 100%
and `components/providers/AccountSwitchReset.tsx` remain enforced by
`package.json`'s own `coverageThreshold`; the policy asserts those numbers
rather than re-implementing them, so lowering one is a failure here as well as a
lie there.

**8. No snapshot inflation.** Zero `toMatchSnapshot()` / `toMatchInlineSnapshot()`
in this package, asserted as an equality. A snapshot over a rendered screen
covers hundreds of statements while asserting only that today's output equals
today's output: coverage without confidence, and the cheapest possible way to
satisfy every number above.

## The web-fork trap, and the one thing that catches it

`jest-expo` resolves the **native** platform extension, so `import './X'` never
loads `X.web.tsx`. Measured on this repository:

- A syntax error inserted into `lib/socketBfcache.web.ts` — a fork nothing
  imports by name — left `test:coverage` at **exit 0**, 165/165 suites passing.
  jest printed `Failed to collect coverage from …` into the log and carried on.
  The file dropped out of the denominator, so overall statements went **up**,
  28.34% → 28.35%, and its uncovered statements left the overall count. Every
  number-based check reads that as an improvement.
- The same mutation in `lib/webTelemetry.web.ts`, which `__tests__/webTelemetry.test.ts`
  imports as `@/lib/webTelemetry.web`, failed the suite immediately.

So a web fork is reachable by the suite **iff a test names the `.web` specifier**
— three of this package's sixteen forks do, and they are pinned like anything
else. The rest are listed in `unenforceable`; a coverage floor on them would be
a number nobody could move, and `tsc` plus `expo export --platform web` are
their real gates.

The signal that does not lie is the file's **absence from the report**, so the
policy asserts that every domain file appears in it. That is the check that
catches an unparseable fork, and it is the only one that can: the numbers all
move the reassuring way.

## When the gate stops you

| message                                            | what to do                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `classified nowhere`                               | New logic file. Run `coverage:record`, or list it in `unenforceable` with a reason and bump `expectedCounts.unenforceable`.      |
| `more uncovered code than their pin allows`        | A test stopped exercising the file, or code added to it is covered worse than the file already was. Cover it — do not re-record. |
| `critical-path file(s) are under the bar`          | Raise the coverage. An exemption needs a reason, a date and a bumped exact count, and should be argued in review.                |
| `Overall <metric>: N uncovered, at most M allowed` | The change added code covered worse than the average, or lost a test. Cover it.                                                  |
| `Overall <metric>: N uncovered, K fewer than …`    | Good news, and a warning only: `coverage-reanchor.yml` re-anchors `main` daily.                                                  |
| `looser than <base>'s`                             | The committed baseline allows more than the base revision's. If that is deliberate, add an `allowedBaselineRelaxations` entry.   |
| `this script reads schema 2`                       | The baseline predates counts. `test:coverage`, then `coverage:record`.                                                           |
| `missing from the coverage report`                 | A file failed to parse. Search the run's output for `Failed to collect coverage from`.                                           |

## What this policy does NOT do

- **A new file is not required to be tested** — only that its absence is
  recorded. A new file at 0% passes once pinned; what it cannot do is pass
  silently, and it cannot later get worse. It still counts toward the overall
  rule, so it must be paid for by covering something else, absorbed by banked
  slack, or accepted in `allowedBaselineRelaxations`.
- **A pin at 0% is a pin that cannot fail.** Its own rate lets added code be
  uncovered too; its value is the exact count around it and the overall rule.
  The critical-path files in that position are each named in
  `belowBarExemptions`.
- **Diff coverage is not measured.** "This pull request's changed lines are N%
  covered" needs per-line data joined to the diff, which is a different report
  than the one CI keeps. The global ratchet is the approximation: code added
  must be covered at least as well as the recorded average.
- **The bar is not per-domain.** Every critical path is held to one pair of
  numbers rather than a threshold tuned per area.

## Adding to the policy

The critical list should grow. When you cover a file that belongs to one of the
seven areas, add it to `criticalPaths` and bump `expectedCounts.criticalPaths`
in the same change. When you cover an exempt one, delete its exemption — the
policy will fail until you do, which is deliberate.

`scripts/test-coverage-policy.mjs` mutation-tests every check above against a
synthetic fixture, positive control first. Run it with
`bun run --cwd packages/frontend coverage:policy-selftest`. A new check without
a case there is a check nobody has seen fail.
