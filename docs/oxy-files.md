# Oxy Files: who owns a file, who uses it, when it goes away

Mention's side of Oxy's ADR 0041, *Who owns a file, who uses it, and when it
goes away* (in the Oxy repository's `docs/adr/`).
Oxy owns every file; Mention says which ones it USES, owns the files no person
owns (the GIF library, report evidence), and reacts when Oxy takes a file away.

The code is `packages/backend/src/db/oxyFiles/` and
`packages/backend/src/services/oxyFiles/`; the schema is
`packages/backend/src/db/schema/oxyFiles.ts` and migration
`0075_oxy_file_references`.

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

`post` is sent as 32 entity types because Oxy reconciles at most 500,000 pairs
per entity type and session; the shard is the first byte of the MD5 of the post
id modulo 32, computed identically in TypeScript and SQL (`shardOf`,
`shardSql`). A shard nearing the cap fails its reconciliation loudly: raise
`POST_REFERENCE_SHARDS` (a change of entity type names — reconcile the old
names empty afterwards).

Not referenced: a federated item the cache never re-hosted (its id is a URL), a
client temp id, and the federated media cache's own files.

## How references follow the data

1. **Triggers mark** (migration 0075). An insert, delete or id change on any
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
each file from its own CDN as an application file; one transaction points the
row and every post at the new ids and records the old id in
`gif_cache_file_retirements`; the old cache file is then deleted unless the
federated media cache holds the same bytes (`kept`). The post insert maps a
retired id to its replacement, so a client that fetched a GIF before the move
cannot write a dangling one.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OXY_FILE_REFERENCES_ENABLED` | `true` | `false` pauses the reference drain (marks accumulate; federated deletions of files Mention referenced wait) |
| `OXY_FILE_REFERENCE_RECONCILE_MODE` | `dry_run` | `off`, `dry_run` (records what would change), `apply` |
| `OXY_FILES_WEBHOOK_SECRET` / `_PREVIOUS` | unset | the file-events signing secret Oxy returned when the endpoint was set |

The first two are optional task variables (repository variables of the same
name, validated by `.github/scripts/optional-task-bindings.sh`).

## Rollout

1. Oxy API with ADR 0041 stages 1–3 deployed; `@oxy.so/core` 4.14.0 published.
2. Staff grant the Mention application `files:app:write` and
   `files:references:write` (staff-only for a `first_party` application).
3. Deploy Mention. References start draining; the reconciliation runs nightly
   as a dry run.
4. Read the dry runs (`oxy_file_reference_reconciliations`), then set
   `OXY_FILE_REFERENCE_RECONCILE_MODE=apply`. The first applied run is how
   existing posts, banners and GIFs enter Oxy's model — it must run before Oxy
   switches its lifecycle sweep to `enforce`, or the GIF library reads as unused.
5. Run the GIF library migration (dry run, then apply).
6. Set the file-events endpoint (console → Webhooks → File events,
   `https://api.mention.earth/webhooks/oxy/files`), store the returned secret in
   SSM `/oxy/mention/OXY_FILES_WEBHOOK_SECRET`, then bind it in both deploy
   workflows' `TASK_SECRET_OVERRIDES_JSON` (a parameter must exist before it is
   named there, and it can only exist after the endpoint answered the
   challenge — which needs step 3).
