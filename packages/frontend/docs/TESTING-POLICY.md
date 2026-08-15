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

When you have legitimately raised coverage:

```bash
bun run --cwd packages/frontend coverage:record  # rewrites coverage-baseline.json
```

Commit the baseline in the same change. `coverage:record` never lowers anything
past the base revision — that is the check the ratchet rests on.

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

**3. Per-file pins.** Each classified file carries its measured coverage,
floored to whole points. Pins fire downwards only, so they cost nothing to carry
and catch the one thing an aggregate hides: a single critical file losing its
tests while the total is held up elsewhere. Deleting
`services/__tests__/followGraph.test.ts` moves the global number by 0.02 points
— under every global floor, past every jest threshold — and trips the pin by
100.

**4. The critical-path bar: 80% statements, 65% branches.** Applied to the seven
areas issue #700 names:

| area | files | clear the bar |
|---|---|---|
| authentication, session and account switching | 4 | 3 |
| composer and post mutations | 7 | 1 |
| React Query cache keys and invalidation | 6 | 6 |
| permissions and channel management | 4 | 3 |
| federation-facing UI state | 4 | 1 |
| deep links and share intents | 3 | 1 |
| feed pagination and state restoration | 6 | 3 |

Branches are held higher relative to reality than statements on purpose: a
permission check, a consent gate and a cursor boundary are all branches, and a
test that walks the happy path covers every statement in them.

The sixteen files that do not clear it are in `belowBarExemptions`, each with a
reason and a date. That list is the honest half of the policy — it says out loud
which named-critical code is untested instead of lowering the bar until
everything passes. It carries an **exact** count, not a maximum, so it cannot
grow one defensible line at a time; and an entry that starts clearing the bar is
reported as a failure until it is deleted.

**5. The ratchet.** Overall coverage below the recorded baseline fails. More
than 0.75 points **above** it also fails, asking you to re-record — without
that, the baseline never refreshes and a suite that reached 40% could fall all
the way back to 28% unnoticed.

**6. The baseline may not decrease against the base revision.** Every other
check reads the committed baseline, so without this one a pull request could
lower the baseline in the same commit that removes the tests and pass all of
them. A genuine decrease — code that legitimately shrank — needs a dated,
path-and-metric-named entry in `allowedBaselineDecreases`, and an entry that is
not currently excusing a real decrease fails, so the list cannot become a
standing permission slip.

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
  28.34% → 28.35%. Every percentage-based check reads that as an improvement.
- The same mutation in `lib/webTelemetry.web.ts`, which `__tests__/webTelemetry.test.ts`
  imports as `@/lib/webTelemetry.web`, failed the suite immediately.

So a web fork is reachable by the suite **iff a test names the `.web` specifier**
— three of this package's sixteen forks do, and they are pinned like anything
else. The rest are listed in `unenforceable`; a coverage floor on them would be
a number nobody could move, and `tsc` plus `expo export --platform web` are
their real gates.

The signal that does not lie is the file's **absence from the report**, so the
policy asserts that every domain file appears in it. That is the check that
catches an unparseable fork, and it is the only one that can: the percentages
all move the reassuring way.

## When the gate stops you

| message | what to do |
|---|---|
| `classified nowhere` | New logic file. Run `coverage:record`, or list it in `unenforceable` with a reason and bump `expectedCounts`. |
| `lost coverage they had at the recorded baseline` | A test stopped exercising something. Add the assertion back — do not re-record. |
| `critical-path file(s) are under the bar` | Raise the coverage. An exemption needs a reason, a date and a bumped exact count, and should be argued in review. |
| `Overall … fell to X%` | The change added code nothing covers. Cover it. |
| `Overall … rose to X% but the baseline still says Y%` | Good news. `coverage:record` and commit the baseline. |
| `lower than <base>'s` | You (or `coverage:record`) lowered the committed baseline. If the code legitimately shrank, add an `allowedBaselineDecreases` entry. |
| `missing from the coverage report` | A file failed to parse. Search the run's output for `Failed to collect coverage from`. |

## What this policy does NOT do

- **It does not require new logic to be tested** — only that its absence is
  recorded. A new file at 0% passes once pinned; what it cannot do is pass
  silently, and it cannot later get worse. Only files on the critical list face
  a real floor.
- **A pin at 0% is a pin that cannot fail.** Its value is the exact count around
  it, not the number itself. Sixteen critical-path files are in that position
  today and each one is named above.
- **Diff coverage is not measured.** "This pull request's changed lines are N%
  covered" needs per-line data joined to the diff, which is a different report
  than the one CI keeps. The global ratchet is the approximation: new code must
  be covered at least as well as the current average.
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
