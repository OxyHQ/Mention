# Explore recency-decay query diagnosis

The frontend deployment gate reached Explore's real route but remained on its
feed skeleton. The live `GET /feed/mtn?descriptor=explore&limit=20` query failed
at PostgreSQL's existing 15-second statement timeout and returned 503. The
correlated request recorded one failed database query, 15,000.79 ms of query
time and zero Oxy calls. This was a backend scoring failure, not a missing web
chunk. The navigation gate and its live HTTP assertions remain unchanged.

Production diagnostics on 2026-11-16 used the existing task definition `oxy-mention:944`, one
database connection, read-only transactions and a five-second diagnostic
statement bound. They changed no service configuration, index, schema or data.
The representative source queries froze the ranking time at
`2026-11-16T18:08:18Z`; they were not reconstructions of redacted request binds.

- Exact discovery filtering without scoring completed in 1,916.587 ms, including
  1,704.857 ms of I/O. It admitted 25,347 rows and removed 72,545 rows.
- Selecting only IDs and scores before full-row hydration reduced estimated
  sort width from 1,977 to 67 bytes but still exceeded the diagnostic five-second
  bound. That projection rewrite was not adopted.
- Changing only `power` operands to double precision, while retaining the full
  original projection and query shape, completed in 1,249.297 ms without a
  language filter and 1,349.9 ms with English filtering. Each returned 21 rows.
  These are isolated query timings with differing cache conditions, not an
  end-to-end latency guarantee or a measured speedup ratio.
- Comparing exact and floating-point power over 100 recent eligible rows per
  context found identical score bits and ordering in those samples. This does
  not establish identity for all ages or engagement values. Ranking revision 4
  therefore invalidates old Explore score cursors, ranked sessions and anonymous
  cached pages through their existing compatibility mechanisms.

The source keeps the same score formula, safety and language guards, frozen
24-hour window, keyset and limit. A PostgreSQL-plan regression checks the
actual executed source query's `power` overload without a timing threshold.
Database tests cover score ordering, frozen pagination and rejection of old
cursor revisions; session and controller tests cover the other cutover paths.

The live endpoint and full frontend promotion must be verified after deployment;
read-only diagnostic measurements alone do not establish that rollout.
