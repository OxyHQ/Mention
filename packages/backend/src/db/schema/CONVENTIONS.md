# Postgres schema conventions — Mention

Binding for every table in this schema. Decision + reason, nothing else. The
two prime directives that shaped it during the port from MongoDB — **no
relational link may be lost**, and **no Mongo baggage travels** — still decide
new tables. Where they conflict, STOP and escalate rather than resolving it
silently: `posts.parent_post_id` is the one place that happened, and it is
recorded as an open decision rather than settled here.

Several of these are enforced by tests, not by discipline — see the bottom.

## The driver is `postgres.js`, never `bun-sql`

Drizzle over `postgres.js` (`drizzle-orm/postgres-js`), migrations applied by
`db/migrate.ts`. The ECS image runs the backend under Bun, so
`drizzle-orm/bun-sql` looks tempting; it is wrong, because the test suite runs
under node and `bun-sql` reaches for the `Bun` global and hard-fails the moment
anything loads it outside Bun. `postgres.js` serves the container, `bun --watch`
and vitest from one code path.

---

## The fact that shapes everything: there is no `users` table

Oxy owns identity. Mention reaches it over HTTP, so **every `oxy_user_id`,
`user_id`, `owner_oxy_user_id`, `actor_id`, `recipient_id` and friends is a
FOREIGN SERVICE's primary key** and can carry no foreign key. That is not a gap
to close later: a shadow `users` table would be a cache that can disagree with
Oxy, and validating on write would put an HTTP round trip in front of every
insert.

`deferredForeignKeys.ts` classifies them with ONE predicate
(`isOxyAccountColumn`) rather than several hundred identical entries, and every
OTHER unconstrained id-shaped column is listed individually with its own reason.
Between those two lists and the real constraints, every id-shaped column in the
schema is classified — which is what lets a NEW one nobody decided about fail
the build.

## Naming

**Tables: explicit snake_case, plural.** `post_authorships`, not the
Mongoose-derived `postauthorships` this data arrived under. The derived name was
a `pluralize()` artifact rather than a design, and no call site was shimmed to
keep it.

**Columns: camelCase in TypeScript, snake_case in SQL**, derived by drizzle. Do
not pass an explicit column name unless the SQL name genuinely differs from the
property.

**`db/casing.ts` is the naming authority.** `DATABASE_CASING` is read by
`drizzle()` (what queries reference), by `drizzle.config.ts` (what the DDL
creates), and by `sqlColumnName`. One setting, not three copies.

> **Trap:** `column.name` on a drizzle column is the TypeScript **property** name
> (`expiresAt`), never the SQL name (`expires_at`) — casing is applied when SQL
> is built. Using it in hand-written SQL throws `column "expiresAt" does not
> exist`; using it in a catalogue query or an `endsWith('_id')` filter silently
> matches nothing and the check passes vacuously. Always `sqlColumnName(column)`,
> or interpolate the Column itself into `sql` and let drizzle render it.

> **Trap, second guise — the one that costs data, not a crash:** a drizzle column
> interpolated into `sql` renders **bare** when its table is not in that
> statement's `FROM`. In a correlated subquery,
> `where ${likes.postId} = ${posts.id}` renders `where "post_id" = "id"` — both
> names then resolve against the SUBQUERY's own table, the predicate compares two
> of its columns to each other, and the query returns `[]` **with no error at
> all**. This shipped in the sibling oxy-api port: follow counts read zero on
> every public profile until a test caught it. Qualify every correlated reference
> with `qualified(column)` from `db/casing.ts`, and treat "a correlated subquery
> returned nothing" as a bug in the SQL until proven otherwise.
>
> Related: `${col} <> all(${jsArray})` binds a TUPLE, not an array, and Postgres
> raises `op ANY/ALL (array) requires array on right side`. Use `inArray` /
> `notInArray`.

> **Third trap, on the read side:** `db.execute` bypasses drizzle's column
> mappers. A `timestamptz` comes back as a raw STRING and `res.json` ships it as
> happily as a `Date`, changing the wire format with nothing to notice. The
> write direction is friendlier — it throws `ERR_INVALID_ARG_TYPE` — which is
> exactly why the read direction is the dangerous one.

**Reserved words are fine.** `user_saved_feeds.order` stays `order`; drizzle
quotes every identifier it emits. Hand-written SQL must quote it too.

## Primary keys

`text`, holding the 24-char ObjectId hex verbatim for pre-cutover rows and a
**uuid v7** for new ones. This is not negotiable and not a convenience:

- The MTN `rkey` **is** a Mongo `_id`, and `rkey`/`collection`/`subject` are all
  inside the signed envelope. A remapped id invalidates every record ever signed.
- Every published ActivityPub identifier below the actor embeds one: the Note id,
  the `Create`/`Announce`/`Update` id, the `Delete` id and its `Tombstone`
  `object.id`, the `Like` id, the `Follow` id. Remote servers hold those. A
  remapped id makes a deletion un-honourable.
- CrowdSource holds `Post._id` as `subject.externalId` and `Report._id` as
  `externalReportId`.

**v7 is generated in the application** (`generatedId()` in `columns.ts`, via
`$defaultFn`), not by a database `DEFAULT`. Postgres 17 has no native
`uuidv7()`. Rows inserted by raw SQL get no id — intended: the backfill supplied
each `_id` verbatim, which is how every foreign key survived the copy by
construction.

`uuidv7()` is implemented here rather than taken from the `uuid` package, for a
measured reason: `uuid@14` is ESM-only under the node condition and this package
emits CommonJS, while `uuid@11` would collide with the transitive `uuid@3.4.0`
already hoisted at the workspace root.

**It carries NO monotonic counter, so id order is not insertion order within a
millisecond.** `uuidv7()` is 48 bits of `Date.now()` followed by
`randomFillSync`; RFC 9562's optional `rand_a` sub-millisecond sequence is not
implemented. Two rows minted in the same millisecond therefore order on their
random tail — measured at 49.3% inversion over 20,000 pairs, a coin flip rather
than an edge case. The id is still a UNIQUE and STABLE total order, which is
exactly what the keyset pagination in `mtn/feed/CursorBuilder.ts` needs from it:
every feed sort spells the id LAST, after `score` and/or `created_at`, so
chronology is carried by `created_at` and the id only breaks the remaining ties.

Two consequences, both of which have already cost real debugging time:

- **Never assert which of two rows written back to back leads.** A database round
  trip usually spreads inserts across milliseconds, so such an assertion passes
  for months and then fails at random, reading as a ranking or pagination
  regression. Test fixtures state the tie instead —
  `__tests__/helpers/tiedIds.ts`.
- **If true insertion order is ever load-bearing, it needs a `position` column
  and a migration, not a different sort.** `post_content_variants` and
  `post_sources` already have one; `db/posts/postRepository.ts` records where the
  absence of one is deliberate.

**Two exceptions, both caller-supplied ids with no generator:**
`moderation_outbox.id` (deterministic, so a retry re-derives the same row) and
`moderation_events.id` (the CrowdSource event id — the primary key IS the §10.8
dedupe). A table whose id is supplied by its caller says so by having no default.

**`db/ids.ts` `isLiveEntityId` is the ONLY place either id shape is spelled out,
and it is not a query precondition.** It exists for the one documented-400 case
(`middleware/validate.ts` `validateObjectId`, which accepts both shapes).
Reaching for it to guard a QUERY re-introduces the fail-open bug the port
removed: the ObjectId-validity guards that used to sit in front of reads did not
merely reject bad input, they made a real record invisible and the caller answer
"it no longer exists". A `text` id that matches no rows needs no guard.

**`MediaMetadataService.isOxyFileId` is a DISCRIMINATOR, not an id validator, and
must not widen.** It answers "is this an Oxy file id or a raw federated URL". The
shape belongs to oxy-api, so it widens if and when Oxy's file ids change and
never because Mention started minting uuid v7.

## Closed value sets

**`text` + a CHECK constraint. Never a pg `enum` type.**

- `text({ enum: [...] })` gives drizzle the same literal-union TypeScript type an
  enum would, so the enum type buys nothing at compile time.
- Adding a value to a pg enum is easy; **removing or renaming one is not
  possible**. A CHECK is ordinary `DROP CONSTRAINT` / `ADD CONSTRAINT`.
- Declare the values once as a `const` tuple and derive both the column type and
  the CHECK from it, so they cannot drift.

**Every CHECK here is WIDER than the model it came from, on purpose.** Mongoose
enums were never enforced on an update — `Post.updateOne` ran no validators — so
the collection this data was copied from held values its own schema forbade:
`posts.status` was already `'restricted'` in production while the model declared
three values, and `post_attachments.type` included `'room'` in
`@mention/shared-types` but not in the model's enum. A narrow CHECK would have
rejected real rows at backfill time. Each one is the union of the old enum, the
shared-types union, and every literal written anywhere in the code; widen a CHECK
the same way rather than trusting one declaration.

For an ARRAY column the constraint is on the ELEMENTS, which a scalar enum cannot
express: `posts.reply_permission <@ array[...]`. A CHECK may not contain a
subquery, so "every element is in range" is written as array CONTAINMENT
(`user_behaviors.active_hours <@ array[0..23]`), never `unnest`.

## Timestamps

Always `timestamptz`, always `mode: 'date'` (`timestamptz()` in `columns.ts`).
`timestamp` without a time zone reinterprets the value in the session's
`TimeZone` on every read, silently changing what a Mongo `Date` meant.

| Mongoose | Postgres |
|---|---|
| `timestamps: true` | `created_at` + `updated_at`, both `NOT NULL DEFAULT now()` |
| `timestamps: { createdAt: true, updatedAt: false }` | `created_at` only — the ABSENCE of `updated_at` is the append-only contract |
| `timestamps: false` + own `createdAt: { default: Date.now }` | `created_at`, identical to the row above |

**`updated_at` is maintained by the application** (`$onUpdate`), matching
Mongoose. Deliberately not a trigger: a trigger is invisible in the schema file,
and it would fire during backfill and overwrite the historical value the
migration exists to preserve.

**One deliberate exception:** `mention_node_ingest_witnesses.ingested_at` stays a
raw millisecond `bigint`, because it is part of the canonicalized signing input
and must round-trip byte-identically. A `timestamptz` would re-render it.

## Foreign keys

Every relation gets a real constraint with an **explicitly decided `ON DELETE`**.
`ON UPDATE` is never declared: ids are immutable.

`deletePost` (`controllers/posts.controller.ts:1687`) is the reference: it
deletes the post and then, best-effort, its article, poll, likes, bookmarks and
notifications — and does NOT touch replies, boosts or quotes. Each self-reference
on `posts` states its choice against that:

| Column | Action | Why |
|---|---|---|
| `boost_of` | CASCADE | A `type:'boost'` row has an intentionally EMPTY body and exists only to point at the original. Mongo leaves permanently blank cards behind. |
| `quote_of` | SET NULL | A quote has a body of its own and must outlive its subject; NULL is exactly "the quoted post is gone". |
| `thread_id` | SET NULL | Continuations are real posts. |
| `parent_post_id` | SET NULL — **ESCALATED** | Neither choice is a faithful port. See below. |

**`parent_post_id` is an open decision, not a settled one.** Today an orphaned
reply keeps a dead id and root feeds exclude it because `notAReplyClause()` tests
`parentPostId: null`. `SET NULL` therefore PROMOTES an orphaned reply into a root
post and it starts appearing in For You / Following / Explore; `CASCADE` instead
deletes reply subtrees that survive today. `SET NULL` is used because it loses no
rows and is repairable while CASCADE destroys user content irreversibly — but
the query phase MUST make root-feed membership stop depending on
`parent_post_id IS NULL` alone before this ships.

**`ON DELETE SET NULL` needs care where NULL already means something.** Nothing
in this schema hits that today; check it for every new relation.

## Expiry — the Mongo TTL replacement

Postgres has no TTL index and seven Mention models relied on one. The mechanism
is defined once in `db/expiry.ts`; a table adds a registry entry rather than its
own cleanup path. An entry is the exact analogue of a Mongo TTL index —
`{ table, column, retentionSeconds }` → `delete where column <= now() - N`.

Every registered column MUST have a supporting btree index (the sweep's predicate
is a range scan; Mongo's TTL index carried the same obligation). Deletion is
batched via `ctid` so a backlog cannot hold one long transaction open.

**Check every registry entry for INTENT, not just for a deadline.** A Mongo TTL
index DELETED the document, and the sibling oxy-api port found one written
meaning "mark expired" that had been destroying subscription history. Six of
Mention's seven are genuine housekeeping. The seventh — `engagement_outbox` —
deletes **unprocessed work**: the predicate is the deadline alone, not the
status, so a `pending` event whose dispatcher stalled for the whole window is
destroyed rather than retried. That was deliberate in the original model
("operational alerts must fire well before this deadline"), and the alerting is
what makes it safe — so the sweep must not be scheduled into an environment that
lacks it.

**Coexistence with reads.** Mention has no read path that depends on a swept row
already being GONE — every consumer either filters on its own deadline or is a
rolling view where an extra old row is stale, never unsafe. Keep it that way:
adding a read that relies on absence turns the sweep interval into a correctness
window.

## Unique constraints

Mongo unique index → `UNIQUE`. Mongo `sparse`/`partialFilterExpression` → a
Postgres partial unique index (`uniqueIndex().where(...)`).

Postgres treats NULLs as DISTINCT by default, so a plain `UNIQUE` on a nullable
column is already correct — but the partial form is kept where Mongo used one
(`starter_packs.source_uri`, the MTN chain indexes), because it also keeps the
index the size of the real set and states the v1/v2 split at the constraint.

A sparse-unique column must be written **NULL, never `''`** — an empty string is
a VALUE, so it collides for real, converting a non-problem into a live bug.
`bookmarks.folder` is the one to watch: `default: null` there means "unfiled".

Three invariants Mongo could not state at all, now constraints:

- `post_authorships` — exactly ONE `owner` per post (a partial unique index).
  `getOwnerId` has always assumed it.
- `post_content_variants` — at most one rendition per language per post, with
  the untagged primary exempt.
- `threadgate_allow_rules` — `listOnly` requires a list id and every other rule
  forbids one.

## Arrays and objects

- A scalar array (`hashtags`, `tags`, `search_terms`) → a native `type[]`, with
  a GIN index where Mongo's multikey index served an `$in`. Postgres arrays are
  first-class; a child table for a set never queried by element is
  over-normalization.
- An array of IDS or entities → a real junction table. Never a `jsonb` id array:
  it cannot be joined, constrained, or usefully indexed. `starterPackCuration.ts`
  is the proof — its `$in` + `$unwind` + two-level `$group` is a join Mongo could
  not perform.
- A `Mixed`/`Map`/nested object with a known shape → real columns or a child
  table. `post_variant_alt_texts` was a `Record<mediaId, string>`; as a table,
  "does this media have localized alt in language X" becomes indexable.
- `default: undefined` on an array means "absent", which is a nullable column
  with NO default — not `'{}'`, which is a different value.

**`jsonb` is for genuinely shape-less data only.** There are exactly four:
`mention_signed_records.envelope` (a signed document that must round-trip),
`custom_feed_definition_modules.params` (defined by the module, not the engine),
`federation_delivery_queue.activity_json` (an arbitrary ActivityStreams
document), and the two moderation payloads (§10.11 makes a published decision
LOOSE — projecting it would silently drop whatever a newer CrowdSource added).

The envelope is safe as jsonb because verification re-canonicalizes from the
PARSED value, so jsonb's key reordering, duplicate-key collapse, number
reformatting and unicode unescaping are representation-only. One hazard remains,
and it is the correct failure mode: a NUL byte fails the INSERT loudly.

## Mongoose behaviour that has no schema counterpart

`trim: true`, `lowercase: true` and setter-style defaults were Mongoose
APPLICATION behaviour. Postgres has no equivalent, so normalization lives at the
CALL SITE and belongs there for anything new too. It is deliberately NOT encoded
as CHECK constraints: a CHECK would have rejected existing rows at backfill time
and turns a silent normalization into a 500.

The federated-actor model was the instructive case — it REMOVED its `trim`
because it was worse than nothing (it strips the ends of a string and does
nothing to the newline inside a display name, which is the actual bug).
Normalization there belongs to the three ingest paths that must strip HTML and
decode entities BEFORE normalizing. Nothing was added back.

## Protected columns — the `select: false` replacement

**Mongoose had `select: false`; Mention used it on no model.** That is the reason
to have this module, not to skip it: a column only stayed out of a response
because no DTO happened to include it, and `db.select().from(t)` returns EVERY
column. The first naive port of a query was the first time
`actor_key_pairs.private_key_pem` — the key that signs every outbound
ActivityPub request for a user — can leave the process.

Four parts, and the third is the one a convention could not give you:

1. **The registry is data** (`PROTECTED_COLUMNS`), one entry per column with its
   reason.
2. **`publicColumns(table)` is the sanctioned read.**
3. **The exclusion is at the TYPE level.** The row type has no `privateKeyPem`
   property, so a serializer that reads one fails `tsc` rather than shipping it.
4. **Opting in is explicit and greppable.** A signing path names the column.
   There is deliberately no helper — it must read differently from an ordinary
   select.

The registry is SHORT because Mention holds exactly one secret at rest. Its value
is the SCAN, which fails a bare `select()` anywhere in `src/`.

## Generated columns

Where Mongoose derived a value in a hook, the derivation belongs in the schema —
not because it is tidier, but because a hook is bypassable and a
`GENERATED ALWAYS ... STORED` column is not. No write path (route, service,
backfill, `psql`) can produce a row whose derived value disagrees with its
source: an attempt fails with SQLSTATE `428C9`.

**The trap: the expression must be IMMUTABLE, and the obvious spellings are not.**
Measured against `pg_proc.provolatile`, not assumed:

| Want | Rejected | Use |
|---|---|---|
| a `tsvector` from text | `to_tsvector(x)` — STABLE, reads `default_text_search_config` | `to_tsvector('english', x)` with a LITERAL config |
| a `tsvector` from `text[]` | `to_tsvector('simple', array_to_string(a, ' '))` — `array_to_string` is STABLE | `array_to_tsvector(a)` — IMMUTABLE |
| a point | — | `ST_MakePoint(lon, lat)::geography`, both IMMUTABLE in PostGIS 3.5 |

## Text search

A Mongo text index becomes a `tsvector` GENERATED column plus a GIN index — never
`LIKE '%…%'`, which is not a port of a text index but a table scan wearing one's
clothes.

- `post_content_variants.search_vector` uses `'english'`, Mongo's
  `default_language`. Note the port CHANGES SHAPE: Mongo indexed the multikey
  `content.variants.text` on the post document, so search now joins the variants
  table back to `posts`.
- `gifs.search_vector` reproduces Mongo's `default_language: 'none'` and its 5:1
  `searchTerms`:`title` weighting with `setweight(array_to_tsvector(...), 'A')`
  and `setweight(to_tsvector('simple', title), 'B')`. `array_to_tsvector` takes
  each element as a lexeme verbatim, which is also the more faithful port —
  `normalizeToTerms` already lowercases, strips diacritics and drops stop words
  on BOTH the stored terms and the query.

## PostGIS — adopted, and the point is GENERATED

`posts.location` and `posts.content.location` both had `2dsphere` indexes, and
`posts.controller.ts` runs real `$near`/`$geoWithin` queries, so both get the
genuine Postgres equivalent: a `geography` point with a GiST index. No
`earthdistance`/`cube` stand-in and no bounding box dressed up as a distance — a
wrong "nearby" is worse than an absent one.

**The column is `GENERATED ALWAYS AS (ST_MakePoint(longitude, latitude)::geography) STORED`,
never written.** That shape is the decision, not the type. A hand-written geo
column and the two coordinate columns are two representations of one fact, so
they can disagree — and a coordinate-ordering mistake is the most likely thing to
get wrong here, because it does not look wrong: a lat/lon swap yields a plausible
point in the wrong hemisphere. Generating the point makes divergence
unrepresentable and states the `(longitude, latitude)` order in ONE place. NAMED
coordinate columns are the other half of the same fix.

**Any spatial test must verify ORDERING against an independently checkable
real-world distance.** A test asserting only "a row came back" passes against the
exact bug. `postgis.test.ts` anchors on Barcelona→Madrid (~505 km); the
transposed pair reads 658 km and the assertion goes red.

**drizzle-kit cannot emit the `(Point,4326)` typmod** (its `parseType` quotes any
type name outside a hardcoded list, and `geography` is not on it as of
drizzle-kit 0.31.10), so the column is declared bare. The typmod would only
constrain WRITES, and there are none; that the stored value really is a Point at
SRID 4326 is asserted against real rows instead.

**The extension is a precondition of the MIGRATOR, not a migration.**
`db/extensions.ts` declares the requirement as data and `bun run db:migrate` runs
it BEFORE applying anything, so the ordering cannot be got wrong by renumbering,
squashing or regenerating the sequence. `docker-compose.postgres.yml` and CI both
run `postgis/postgis:17-3.5`.

## Indexes

Port the indexes that earn their keep, drop the ones that do not, add the ones
Mongo needed and lacked.

- **Ported by name** where the manifest named them (`post_public_chrono_v1`,
  `post_replies_chrono_v1`, `post_links_chrono_v1`), so a DBA reading
  `pg_indexes` and a developer reading the migration see the same names.
- **Dropped as redundant:** a standalone `{userId: 1}` alongside a compound
  unique that already leads with it — a btree serves any leading prefix.
- **Multikey → GIN**, not btree: `hashtags`, `classification_topics`,
  `classification_languages`. A btree cannot serve `<@`/`&&`.
- **Sparse → partial:** `posts.curated`, `starter_packs.source_uri`, the MTN
  chain indexes. A partial index is the size of the real set.

Do not add an index speculatively.

---

## What is enforced by a test

Not by discipline — these fail the build. All of them run against a REAL
Postgres through the application's own pool, and each has been mutation-tested:
break the thing it guards and it goes red naming the offending table and column.

| Convention | Test |
|---|---|
| snake_case tables and columns; every table has a PK; every timestamp is `timestamptz`; no `''` default; no `_id`/`__v`; PostGIS installed | `__tests__/db/schemaInvariants.test.ts` |
| Deferred FK becomes mandatory when its parent lands; every id-shaped column classified; every FK declares an explicit `ON DELETE` | `__tests__/db/foreignKeys.test.ts` |
| uuid v7 format and ordering; ObjectId hex accepted verbatim; the widened `status` CHECK; array-element CHECKs; one-owner-per-post; one-variant-per-language; the generated search vector; CASCADE/SET NULL behaviour on real rows | `__tests__/db/constraints.test.ts` |
| `geo` is generated, SRID 4326, POINT, built as `(longitude, latitude)`, GiST-indexed, and unwritable | `__tests__/db/postgis.test.ts` |
| Sweep semantics, batching, the index each swept column requires, and the retention constants still equal the Mongoose models' | `__tests__/db/expiry.test.ts` |
| Protected-column registry, the `publicColumns` filter at runtime AND at the type level, and no implicit whole-row read anywhere in `src/` | `__tests__/db/protectedColumns.test.ts` |
