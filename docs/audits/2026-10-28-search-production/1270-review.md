# Issue #1270: production search diagnosis (2026-10-28)

The September 30 failure is attributable to PostgreSQL query cancellation,
not an inferred browser or connectivity problem. Read-only CloudWatch inspection
of Mention's production stream found SQLSTATE `57014`, `timedOut: true`, and the
reported search terms in the failed statement parameters:

- Beck: September 30 at 13:57:15, 13:57:30 and 13:57:59 UTC, among earlier
  occurrences. The failing oldest search window ended August 31 and requested
  only one remaining row (`LIMIT 1`).
- Apple: September 30 at 13:59:57 and 14:00:04 UTC. The failing pagination window
  covered September 8–9, matching the issue's follow-up timing.

No credentials, private post bodies, account identifiers or unrelated search
terms are included here.

## Subsequent root fix and current production verification

PR #1387 (`1749a8fe6`, October 15) introduced migration
`0066_post_search_vector_statistics.sql`: the text-vector statistics target
increased from 100 to 1000 and the column was analyzed. The fix specifically
addresses rare-word estimates that caused a chronological scan instead of a
text-index lookup. The existing `postSearchPlan.test.ts` protects both the
planner configuration and statistics target.

Production read-only inspection confirms target **1000** on
`post_content_variants.search_vector`, an October 15 manual ANALYZE and an
October 27 autoanalyze. The GIN text and chronological indexes are present.
Using the current application's query builder and planner configuration,
`EXPLAIN (ANALYZE, BUFFERS)` on the formerly failing windows gives:

| Query/window | Execution time | Observed access |
| --- | ---: | --- |
| Beck, oldest window before August 31, limit 1 | 2.348 ms | GIN text lookup, 128 candidate rows, post primary-key lookup |
| Apple, September 8–9 window, limit 21 | 219.271 ms | BitmapAnd of GIN text and date indexes, 123 candidate rows, post primary-key lookup |

The Apple probe reproduces the time window without the historical cursor's
redacted tie-break identifier; it does not claim byte-identical pagination.

The current `findPostSearchPage` also returned 21 public, published, discovery-safe
rows for both Beck and Apple, and did so again on repeat. The connection's
`default_transaction_read_only=on` was checked before running the probes;
statements were bounded by the application's existing 3000 ms timeout. No
production rows, settings or statistics were changed.

This supports closing the original database failure as addressed by #1387.
It does **not** claim an authenticated UI replay, end-to-end hydration verification,
or a latency guarantee for every search term. A separate repeated-token timeout
found during the investigation remains a separate performance defect.
