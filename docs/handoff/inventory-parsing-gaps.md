# Six ways a model inventory reports a confident low number

> **The headline, which explains every instance below in one sentence:**
> **the reads are spelled as statics and the writes are spelled as a
> constructor and a `.save()` on the document — so a binding-keyed scan does
> not miss sites at random, it SPECIFICALLY HIDES WRITES, and leaves a port
> looking read-only.**
>
> That is why `UserBehavior` showed four `findOne` reads while concealing the
> `new UserBehavior(` + two `.save()` calls that make it Mongo-authoritative,
> and why a model can look like a leftover while it is actively losing data.
>
> **Beside it, the half people skip:** the first fix for the `new Model(...)`
> gap over-matched at **1062 lines** (`new Error(`, `new Date(`). **Both 1062
> and 2 are useless; only one of them announces itself.** A scanner that cries
> wolf gets discarded, a scanner that under-counts gets believed — same defect,
> opposite visibility.

Every gap below produced a number that **looked like progress**. None errored.
A low count is the most dangerous output an inventory can produce, because it is
indistinguishable from being nearly done.

Measured against a pinned snapshot of **`41deedbd`** (`git archive` into
`scratchpad/snap/`), 553 production files of 1062 walked. Reproduce with
`node measure-gaps.mjs snap/packages/backend`. Scanners:
`census.mjs` (import-walking), `spellings.mjs` (the non-method spellings).

---

## 1. The import parser drops the DEFAULT specifier when named ones follow

**Shape:** `import UserBehavior, { IUserBehavior } from '../models/UserBehavior';`

The extractor sliced the clause at `{`, giving `"UserBehavior, "`, then ran
`.replace(/,$/, '')` **before** `.trim()`. The trailing space meant the comma
never matched, the result failed the identifier test, and the default binding was
discarded in silence. One character of ordering.

| | count |
|---|---|
| produced | **2** sites for `UserBehavior` |
| truth | **8** sites across 4 files |

**It was not confined to one model. 8 model imports repo-wide use this shape**,
and every one was eaten:

```
src/services/UserPreferenceService.ts:1        UserBehavior,     { IUserBehavior }
src/services/ContentAffinityService.ts:59      UserBehavior,     { type IUserBehavior }
src/services/moderation/ModerationDeliveryWorker.ts:1   Report,  { type LeanReport }
src/services/moderation/ModerationDecisionWorker.ts:3   Report,  { type LeanReport }
src/scripts/purgeBlockedDomainContent.ts:173            Report,  { ReportedType }
src/migrations/0004-notification-ttl-index.ts:26  NotificationModel, { NOTIFICATION_TTL_SECONDS }
src/migrations/0015-trend-summary-indexes.ts:31   TrendSummaryModel, { TREND_SUMMARY_TTL_SECONDS }
src/migrations/0003-trending-ttl-index.ts:34      TrendingModel,     { TRENDING_TTL_SECONDS }
```

For `Report` — the model at the centre of the item ruled to be ported as ONE
unit — the same bug reported **7 use-lines across 2 files**, both of which were a
test and a reconciler. The truth is **40 across 8**, and the four it hid include
`ModerationDeliveryWorker`, `ModerationDecisionWorker`, `ReportIntakeService` and
`reports.routes.ts` — i.e. the production write path and both workers. Had the
first number been trusted, moderation would have looked like a two-file job.

## 2. `new Model(...)` — a constructor is not a static

**Shape:** `userBehavior = new UserBehavior({ … })`

A `Model.(find|updateOne|create|…)` scan enumerates statics. A constructor is a
different syntactic position and matches none of them.

| | count |
|---|---|
| naive `UserBehavior.<static>(` scan | **7** |
| `new UserBehavior(` | **1** — `UserPreferenceService.ts:193` |

The one it misses is the **write path**. That is the asymmetry worth remembering:
the reads are spelled as statics and the create is spelled as a constructor, so
the scan that misses one specifically misses the writes.

**Its own failure mode, in the opposite direction:** the first fix was
`/\bnew\s+[A-Z][\w$]*\s*\(/`, which reported **1062 lines** — `new Error(`,
`new Date(`, `new Map(`. A number so large it is unreadable is also a failed
scan; it just fails visibly. Restricting the pattern to bindings actually
imported from `models/` in that same file brings it to **1**, the truth.

## 3. `.save()` — the receiver is the document, not the model

**Shape:** `await userBehavior.save();`

The model binding never appears on the line. No scan keyed on the binding can
see it, however many statics it enumerates.

| | count |
|---|---|
| any scan keyed on `UserBehavior` | **0** |
| truth | **2** — `UserPreferenceService.ts:334`, `:737` |

Both are the second half of a load-modify-write whose first half IS visible at
sites `189` and `722`. So the scan reports the read and hides the write that
pairs with it — leaving a port that looks read-only.

## 4. `Model.collection.*` — dropping to the driver

**Shape:** `db.collection(NotificationModel.collection.collectionName)`

| | count |
|---|---|
| production files | **0** |
| `src/migrations/` | **2** — `0004-notification-ttl-index.ts:39`, `0007-feed-generator-index.ts:32` |

Recorded because the **zero is real but conditional**: it is zero only because
the filter excluded `src/migrations/`. A scan whose exclusion list hides the only
hits reports the same `0` as one that genuinely found nothing. State the filter
next to the count, always.

## 5. Four spellings of the ObjectId shape guard

| spelling | count |
|---|---|
| A `ObjectId.isValid` | 12 |
| B `mongoose.isValidObjectId` | 2 |
| C `Types.ObjectId.isValid` | 12 |
| D `/^[0-9a-f]{24}$/` | 6 |
| **union** | **20** |

**Spelling A alone finds 12 of 20 — it misses 8, or 40%.** A and C return the
*identical* 12 lines, because every one is written `mongoose.Types.ObjectId.isValid`
— so checking a second spelling and getting the same list feels like
confirmation and is worth nothing. The two that matter are B and D, and both sit
on paths that delete or repair:

- `purgeBlockedDomainContent.ts:733`, `:1387` (spelling B) — a destructive sweep.
- `repairFederatedMentions.ts:589` (spelling D) — the repair tool's range bound.

## 6. `require()` — invisible to any import walk

**Shape:** `require("./src/models/UserBehavior");`

| | count |
|---|---|
| import-walking census | **0** |
| truth | **2** — `server.ts:510` (`models/Post`), `server.ts:511` (`models/UserBehavior`) |

Both sit inside `db.once("open", …)` as Mongoose registration. **Deleting the
model without removing line 511 throws `MODULE_NOT_FOUND` at startup, inside an
event handler, on a path no test covers** — after the port's own suite is green.
This one was not on the brief's list; it surfaced only because the measurement
printed full lines and `server.ts:511` appeared in output meant for something
else.

---

## The same defect one layer up: the VERIFICATION harness, not the scanner

Both of these were hit live, in one session, by two different people. Both
answer "no problem" for a reason unrelated to the question, which is the same
shape as gaps 1–6 — but they are worse, because a scanner defect costs you an
inventory while a harness defect costs you a GATE.

### 7. `find -newermt '-3 minutes'` is an ERROR here, not a predicate

`find` on this machine is **`bfs` 4.1.1**, which accepts only ISO-8601-like
timestamps and rejects relative ones:

```
$ find packages/backend/src -type f -newermt '-5 minutes'
bfs: error: Invalid timestamp.
```

Written as `find … -newermt '-3 minutes' 2>/dev/null`, the error is swallowed
and the command **prints nothing and exits cleanly** — indistinguishable from
"no files were modified recently". It was used to conclude a worktree was
quiescent, and to conclude an agent had stalled. It returned empty every time
and *could not have returned anything else*.

| | result |
|---|---|
| the check, against an actively-modified tree | **empty** (= "quiet") |
| truth, same instant | 3 files written in the previous 4 minutes |

**Use instead**, since it needs no predicate and so cannot fail silently:

```bash
find <path> -type f -name '*.ts' -printf '%TY-%Tm-%Td %TH:%TM:%TS %p\n' | sort -r | head
```

Mutation test that settles it in seconds: `touch` a file you own and confirm the
check reports it. Mine did not.

**Corollary that is independently expensive: a quiet interval is not a stop.**
Watching a live agent's tree, four consecutive 15-second samples showed no
change — then a write landed at +2m20s and another at +3m13s. Any window under
~3 minutes would have read as "finished". Absence of writes over a short window
is not evidence of an exit; a committed, confirmed exit is.

### 8. A backgrounded `cmd | tail` reports TAIL's exit status

```bash
bun run test 2>&1 | tail -60      # harness reported: exit code 0
```

The pipeline's status is the LAST command's, so `tail` succeeding masks the
suite failing. The real result that run:

```
Test Files  7 failed | 465 passed (472)
     Tests  36 failed | 5600 passed (5636)
error: script "test" exited with code 1
```

**Never pipe a gate into `tail`.** Capture to a file, read the summary, and
check the status of the command you actually care about (`${PIPESTATUS[0]}`, or
`set -o pipefail`). A harness that reports success for a failed run is the most
expensive false green available, because it sits upstream of every other check.

---

## What actually generalises

1. **A negative or low result is a fact about the PATTERN.** Every gap here is a
   scanner defect wearing the costume of a finding.
2. **Print the full matched line, never a capture group.** Gap 6 was found this
   way and by no other means.
3. **Cross-check the instrument against an independently-derived figure.** The
   corrected census reproducing the brief's "4 files, 8 sites" is the only reason
   the fix is known to be a fix rather than a different wrong number.
4. **Carry a vacuity floor AND state the filter.** Gap 4's honest `0` and a
   broken traversal's `0` are the same character.
5. **Both directions are failures.** 1062 (gap 2's first attempt) and 2 (gap 1)
   are equally useless; only one of them announces itself.
6. **The reads are spelled differently from the writes.** Gaps 2 and 3 both hide
   writes specifically, which is why a scan can leave a port looking read-only.
   This is the headline at the top of this file, restated as a rule.
7. **Suppressed stderr converts a broken command into a confident answer.**
   `2>/dev/null` is what turned gap 7 from a visible error into "the tree is
   quiet". Never suppress stderr on a check whose OUTPUT is your evidence.
8. **Verify the status of the command you care about, not of the pipeline.**
   Gap 8 is one character of shell semantics standing between a red suite and a
   reported green.
