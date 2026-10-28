# Oxy Files: who owns a file, who uses it, when it goes away

Mention's side of Oxy's ADR 0043, *Who owns a file, who uses it, and when it
goes away* (in the Oxy repository's `docs/adr/`).
Oxy owns every file; Mention says which ones it USES, owns the files no person
owns (the GIF library, report evidence), and reacts when Oxy takes a file away.

The code is `packages/backend/src/db/oxyFiles/` and
`packages/backend/src/services/oxyFiles/`; the schema is
`packages/backend/src/db/schema/oxyFiles.ts` and migration
`0077_oxy_file_references`.

## Who owns what

| Files | Owner in Oxy | Lifecycle |
| --- | --- | --- |
| A person's post media, banner, resume (uploaded or imported for them) | the person's account | never deleted behind their back; *not in use* when no app references it |
| Media re-hosted from a federated post | the federated actor's Oxy account | Mention deletes it explicitly when the post is deleted at its source (`federated_media_deletions`) |
| The GIF library (`gifs.storage = 'application'`) | the Mention application | collected by Oxy 24 h after its last reference, purged after 30 days in trash |
| Report evidence copies (`moderation_report_evidence_files`) | the Mention application (`unlisted`) | same; CrowdSource references them as its `case` too |
| The federated media cache (`federated_media_cache`) | Oxy's platform cache namespace | evicted by Mention's eviction job; never referenced |

## Entity types

Every use Mention registers is an Oxy file reference `(fileId, entityType,
entityId)`. The registry is `db/oxyFiles/fileReferenceEntities.ts`; each entry
is marked by a trigger on its table and answers "is this pair in use".

| Oxy entity type | entityId | The file | In use while |
| --- | --- | --- | --- |
| `post.00` … `post.31` | `posts.id` | `post_media.media_id`, `post_variant_media.media_id` | the post (or a language variant's override) shows it; withheld items count |
| `gif` | `gifs.id` | `gifs.mp4_file_id`, `gifs.preview_file_id` | the library row exists |
| `profile_banner` | Oxy account id (`user_settings.oxy_user_id`) | `user_settings.profile_header_image` | it is the account's banner |
| `video_poster` | the video's Oxy file id | `federated_media_posters.poster_file_id` | a post shows the video |
| `job_application` | `mention_job_applications.id` | `mention_job_applications.resume_file_id` | it is the application's resume |
| `moderation_report` | `reports.id` | `moderation_report_evidence_files.evidence_file_id` | the report exists |
| `membership_media` | `membership_media.id` | `membership_media.file_id` | the private upload record exists, including before attachment |

`post` is sent as 32 entity types because Oxy reconciles at most 500,000 pairs
per entity type and session; the shard is the first byte of the MD5 of the post
id modulo 32, computed identically in TypeScript and SQL (`shardOf`,
`shardSql`). A shard nearing the cap fails its reconciliation loudly: raise
`POST_REFERENCE_SHARDS` (a change of entity type names — reconcile the old
names empty afterwards).

Not referenced: a federated item the cache never re-hosted (its id is a URL), a
client temp id, and the federated media cache's own files.

## How references follow the data

1. **Triggers mark** (migration 0077). An insert, delete or id change on any
   table above calls `mention_mark_file_reference(file, type, entity)`, which
   upserts a dirty row in `oxy_file_reference_sync` in the writing transaction.
   That covers every path, including `ON DELETE CASCADE` from `posts` (account
   erasure, channel deletion, scripts). A variant's media is marked by the
   variant's BEFORE DELETE trigger, while it can still be read.
2. **The drain decides** (`services/oxyFiles/fileReferenceSync.ts`, periodic
   queue every 30 s, `oxy-files:reference-sync`). For each due pair it asks
   the registry whether it is in use now and sends Oxy only the difference from
   what Oxy was last told (`synced_op`): `references.add` / `remove`, 100 per
   call. A mark landing mid-call bumps `generation` and the row is decided
   again. Oxy's `not_found` to an add is `refused` (a person's private file,
   or a gone one). Failures back off (1 min doubling to 6 h); a pair with 10+
   attempts raises `oxy_file_reference_stuck` and an error log. Settled rows
   expire after 7 days.
3. **The nightly reconciliation** (`fileReferenceReconciliation.ts`, leader,
   02:00–06:00 UTC, history in `oxy_file_reference_reconciliations`) sends every
   entity type's whole inventory with `references.reconcile`. A pair whose use
   ended while the inventory was being read is re-added by the commit, so after
   an applied commit every removal answered since the read began is sent again,
   and a federated deletion Oxy kept as `in_use` for those files is re-opened.
   Every reconciliation request counts toward Oxy's 240 a minute per
   application, and the SDK sends a session's pages back to back, so the
   inventory is handed to it as a paced stream (a 500 ms pause between pages);
   an entity type Oxy still answers 429 is tried again after a minute.
   `.github/workflows/run-file-reference-reconciliation.yml`
   (`scripts/reconcileOxyFileReferences.ts`, `mode: dry_run` first) runs the
   same function on demand; the scheduler counts it as that night's run.

### Federated media deletion

A re-hosted file belongs to the federated actor's account, and Oxy refuses to
delete an account's file another application references (`in_use`). So the
deletion drain (`services/mediaCache/federatedMediaDeletion.ts`) still decides
"does Mention show it" locally, under the locks the post insert takes (Oxy's
references trail the database by the drain, so they cannot stand in for that
check), and then calls `clearFileReferencesBeforeDelete`: every pair of the file
not certainly removed is sent to Oxy from the current data, and the delete is
asked for only once all are. Otherwise it is retried.

## File events

`POST /webhooks/oxy/files` (`routes/oxyFileEvents.routes.ts`), mounted before
`express.json()` (an HMAC over the raw body is the authentication,
`verifyFileEventSignature`). The endpoint challenge is echoed even without a
secret; events are refused with 503 until `OXY_FILES_WEBHOOK_SECRET` is set (Oxy
retries). `services/oxyFiles/fileEvents.ts` applies each event in one
transaction, deduped on its id, ordered by `occurredAt`, audited in
`oxy_file_events`:

| File state after the change | Mention |
| --- | --- |
| `deleted` | withholds it (`deleted`, terminal); removes GIF rows using it; clears banners and resumes naming it |
| `blocked` (a takedown) | withholds it (`blocked`); removes GIF rows; clears banners and resumes |
| `trash` | withholds it (`trashed`); for Mention's OWN file, re-sends its GIF references, which restores it |
| `active` + `private` | withholds it (`private`) |
| `active` + `public`/`unlisted` | serves it again |

Withholding (`oxy_file_states.withheld`, copied onto `post_media.withheld` and
`post_variant_media.withheld`, and onto every new row by trigger) keeps the row
and its reference, so `file.unblocked` / `file.restored` still reach Mention.
DTOs (`resolveMediaItems`), ActivityPub attachments, MTN records and the Videos
lane drop withheld items.

## The GIF library

New imports: `importAppFile(klipyUrl, { visibility: 'public' })` — Oxy fetches
and dedupes by URL; a Klipy mp4 served as `application/octet-stream` (Oxy's 415)
is downloaded and uploaded with `uploadAppFile` declaring `video/mp4`. Only
Klipy hosts are imported. The `gifs` row's insert marks both files (`gif`).

Rows from before (`storage = 'federation_cache'`, also the column default, so a
row the previous image writes during the deploy is classified right) are moved
by `scripts/migrateGifLibraryToApplicationFiles.ts`
(`.github/workflows/run-gif-library-migration.yml`, dry run first): Oxy imports
each file from its own CDN as an application file, 25 GIFs per
`importAppFiles` batch (one request of Oxy's 30 imports a minute per
application, which the live picker shares; batches are 10 s apart and one
answered 429 is sent again after a minute); one transaction points the
row and every post at the new ids and records the old id in
`gif_cache_file_retirements`; the old cache file is then deleted unless the
federated media cache holds the same bytes (`kept`). The post insert maps a
retired id to its replacement, so a client that fetched a GIF before the move
cannot write a dangling one.

## Media from a URL

`POST /posts/intent-media` with `{ url }` (compose intents, the MCP
`upload-media-from-url` tool) no longer fetches anything itself: Oxy imports the
URL into the requesting person's own files (`importUserMedia`, public, Oxy's
SSRF-safe fetcher — https only), and the same URL imported again answers the
same file. Inline `base64` bytes are still uploaded as before.

## Refresh metadata after repairing video renditions

Finish Oxy's rendition repair first: the original's display dimensions and
`hlsReadyAt` must describe the validated replacement ladder, and the resolver
cache must have been purged. Mention then copies that authoritative metadata
onto its existing references; it does not probe media during feed hydration.

Use **Run media-metadata backfill** (`run-media-metadata-backfill.yml`) from
`main`, with `file_id` set to the repaired Oxy video id and `dry_run=true`.
Review the post counts, then use `dry_run=false` and the existing exact phrase
`BACKFILL MEDIA METADATA`. Dispatcher authorization is unchanged. Leaving
`file_id` empty and `refresh_videos=false` retain the ordinary missing-metadata sweep.

The equivalent script preview is:

```bash
bun packages/backend/dist/src/scripts/backfillMediaMetadata.js --dry-run --file-id 01a16684-e7ee-7213-8bca-051c9cabce02
```

A targeted refresh includes both `post_media` and language overrides in
`post_variant_media`, even when their old dimensions are valid. It preserves
row identity, text, alt text and authorship; an edit replacing a row or its
file during the lookup is not overwritten. Counters count posts, so multiple
references in one post count once. Repeating the run reports unchanged posts
as skipped. Missing or failed Oxy lookups count as unresolved and produce exit
code 75; they are not reported as successfully repaired.

### Reconcile a video repair backlog

Set `refresh_videos=true` in the same workflow to refresh complete references
across both media tables. `limit_files` bounds distinct video files per pass
(default 1000); use 100000 for a full scheduled pass over the current backlog.
The command is included in the normal production runtime image:

```bash
bun packages/backend/dist/src/scripts/backfillMediaMetadata.js --refresh-videos --dry-run --limit-files 100000
```

Manual and scheduled bulk runs share a PostgreSQL advisory lock. A concurrent
invocation logs `alreadyRunning=true` and exits without scanning or writing. The
lock is released in `finally`, or by PostgreSQL when the task connection closes.
The workflow and scheduled task must also enforce their runtime deadline.

A confirmed write uses the existing `CONFIRM_ADMIN_MUTATION=backfillMediaMetadata`
guard and omits `--dry-run`. The scanner deduplicates file IDs, requests at most
100 files from Oxy at once, and updates only changed intrinsic metadata and
`hlsReadyAt`. Federated audio intentionally stored with Mention's video fallback
is excluded only when Oxy's authoritative MIME is audio; `excludedAudio` counts
these files separately from unchanged videos. Their rows and playback type remain
untouched. Missing assets and incomplete video metadata still count as unresolved;
an absent or unrecognized MIME never excludes a reference by itself. Row/file
identity guards protect concurrent edits; a newer stored readiness stamp is never replaced by an older source response. Changed post
detail caches are invalidated after the transaction commits.

Oxy can explicitly reject a known malformed legacy HLS generation through
`hlsRejectedReadyAt`. Reconciliation clears only that file's observed stored
`hlsReadyAt` at or before the rejected generation, leaving every other column intact; playback then uses the original
URL. Newer generations are retained. Missing readiness or an unknown source is never
interpreted as rejection.
Ingestion applies the same explicit generation rule, and all existing-row
metadata writers compare the captured row, file and readiness stamp before
writing, so an older concurrent lookup cannot restore a cleared generation or
overwrite a repaired one. A later successful generation restores normal HLS
selection through the next scheduled pass.

Every committed batch logs a durable checkpoint. Resume a bounded or interrupted
run with `--after-file-id` / workflow `after_file_id` set to `resumeAfterFileId`.
A null cursor means start at the beginning. Do not use `scannedThroughFileId`
when a lookup is unresolved: the resume cursor deliberately stays before the
first unresolved file. Exit 75 means the file limit or unresolved sources left
work outstanding. Dry-run checkpoints describe the preview, not applied work.

Oxy repairs asynchronously. `--passes` (1–10) repeats completed scans from the
beginning, with `--pass-delay-seconds` (0–600, default 60) between them, even if
the preceding scan was unchanged. A pass stopped by its file limit returns its
cursor instead of repeatedly scanning the same prefix. For a repair lasting
hours or days, run bounded full passes periodically from the live service's
runtime revision; the workflow also supports manual recovery without one build
per file. A 100000-file pass makes at most 1000 Oxy batch requests, plus bounded
keyset queries and writes. Its duration depends on source and database latency.

A successful scan only means the references match the metadata currently
published by Oxy. It does not mean Oxy has finished repairing every ladder.
Run and verify a final complete pass after the upstream repair inventory settles.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OXY_FILES_WEBHOOK_SECRET` / `_PREVIOUS` | unset | the file-events signing secret Oxy returned when the endpoint was set |

There is no switch for references or their reconciliation: the drain always
runs and the nightly reconciliation always applies (an application file nobody
references is collected by Oxy). To see what a run would change first, dispatch
`run-file-reference-reconciliation.yml` with `mode: dry_run`.

## Rollout

1. Oxy API with ADR 0043 stages 1–4b deployed (report evidence is adopted
   through stage 4b's `adoptAppFile`); `@oxy.so/contracts` 4.24.0,
   `@oxy.so/core` 4.21.0 and `@oxy.so/services` 11.12.0 published (the stage 4c
   SDK). Nothing here calls a stage 4c endpoint, so Mention deploys whether or
   not the 4c API is out.
2. Staff grant the Mention application `files:app:write` and
   `files:references:write` (staff-only for a `first_party` application).
3. Deploy Mention. References start draining; the reconciliation runs and
   applies nightly.
4. Read a dry run (`run-file-reference-reconciliation.yml` with
   `mode: dry_run`), then make the first applied run (the same workflow,
   `mode: apply`) rather than wait for the night. The first applied run is how
   existing posts, banners and GIFs enter Oxy's model — it must run before Oxy
   switches its lifecycle sweep to `enforce`, or the GIF library reads as unused.
   Done 2026-10-20: 419,548 references added, 0 removed, 552 refused.
5. Run the GIF library migration (dry run, then apply).
6. Set the file-events endpoint (console → Webhooks → File events,
   `https://api.mention.earth/webhooks/oxy/files`), store the returned secret in
   SSM `/oxy/mention/OXY_FILES_WEBHOOK_SECRET`, then bind it in both deploy
   workflows' `TASK_SECRET_OVERRIDES_JSON` (a parameter must exist before it is
   named there, and it can only exist after the endpoint answered the
   challenge — which needs step 3).

## Protected community files

Membership uploads use `uploadAppFile` with the original foreground requester.
Mention owns this protected copy; local authorship remains with the member. Oxy
denies personal sessions access to private application files, including guardians
and approved contacts of supervised authors. A personal private file is unsuitable:
its supervised-owner contact policy can outlive or bypass community membership.
Uploads require `private` visibility, including deduplicated uploads. Public GIF
imports reject private dedup results and never change their visibility. Their durable references are
registered through the same outbox, reconciliation and deletion triggers (0098),
without impersonating the uploader or replacing the original requester's proof.
Deleting a community, channel or account removes its media records and dirties
those references in the same transaction.

Unattached upload drafts become eligible for expiry after 24 hours. The apply-mode
nightly reference reconciliation deletes them in 500-row batches before inventory,
rechecking `content_id IS NULL` after concurrent row locks. Dry runs do not delete
drafts. Fresh and attached records survive, including another community using
the same application file. Deletion only dirties the removed references; Oxy
retains responsibility for unused-file trash and collection.

Membership reads interpret `oxy_file_states` independently of public-post
withholding: an active **private** file is valid here. A deletion or a change to
public/unlisted visibility removes it from protected content responses and denies
new downloads; ordered callbacks prevent an older private event reopening access.
The linked-download API must also return current `visibility: private` before a
URL is exposed. A missing visibility field during an older API rollout fails
closed. This live check covers visibility changes before callback delivery.
URLs remain short-lived bearer links (Oxy's current limit is 300 seconds), never
stored in posts, public teasers, notifications, search, federation or MTN records.
Already-issued URLs retain that bounded lifetime; revocation is not retroactive
cancellation of a bearer URL.
