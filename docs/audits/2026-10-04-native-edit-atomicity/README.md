# Native edit atomicity

A native edit previously committed language/classification scalars before replacing the content graph. A real shadow claim queued before the content writer could therefore observe the new language with the old body. An insertion failure also left scalar changes committed. The native edit now takes the existing content advisory lock, then the post row lock, and performs both writes in one transaction. An unpublished carve-out is rechecked under the same locks; post-detail cache eviction also occurs after commit.

The unchanged final regression fixture demonstrates three baseline failures and27 fixed passes, using actual PostgreSQL locks, a real controller, a trigger rejecting only the owned synthetic body, and a concurrent draft publication. The expanded nine-suite set passes110 tests, including existing edit/correction/translation and shadow-ledger controls. Backend build passes. Every owned database is stopped.

The proof preserves initial fixture mistakes separately and does not count them as product regressions. Federation and repair callers remain unchanged. There is no production rollout or Jev activation in this evidence.
