package earth.mention.widgets.following

import android.content.Context
import android.util.Log
import androidx.glance.appwidget.updateAll
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import earth.mention.widgets.feedcard.FETCH_INTERVAL_MS
import earth.mention.widgets.feedcard.anyPlaced
import earth.mention.widgets.feedcard.postImageUrls
import earth.mention.widgets.feedcard.rotationImageUrls
import earth.mention.widgets.feedcard.shouldFetchRotation
import org.json.JSONException
import so.oxy.session.OxyBackgroundSession
import java.io.IOException

/**
 * The following widget's one background job: advance the rotation, fetch when the batch is
 * stale, and make sure the post about to be drawn has its images on disk.
 *
 * ROTATING AND FETCHING ARE THE SAME TICK, at different rates — the job runs on the shortest
 * interval WorkManager offers periodic work and moves the rotation on every run, but only
 * re-fetches once the stored batch is older than [FETCH_INTERVAL_MS]. On this widget that
 * split also saves token mints, not just requests: a rotation step needs no session at all.
 *
 * The failure contract has one rule, the same as the trending widget's: this worker never
 * writes an empty or partial rotation. A fetch that does not produce a parsed list leaves the
 * store exactly as it was, and the rotation still advances — so a phone that has been offline
 * for a day shows yesterday's posts, cycling, rather than a blank box.
 *
 * The ONE case that does empty the store is a proven end of session, and that is a privacy
 * rule rather than a failure path — see `FollowingSession.kt`.
 */
internal class FollowingRefreshWorker(
    appContext: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(appContext, parameters) {

    override suspend fun doWork(): Result {
        // The periodic job is cancelled when the last widget is removed, but a run can already
        // be queued when that happens, and a one-off nudge does not know whether the user has a
        // widget at all. Checking here covers both without either caller having to.
        if (!anyPlaced(applicationContext, FollowingWidgetReceiver::class.java)) {
            return Result.success()
        }

        // The session question is asked FIRST, and its answer decides everything below —
        // including whether the stored rotation is allowed to survive this run.
        val auth = classifyBackgroundToken(OxyBackgroundSession.accessToken(applicationContext))

        return when (auth) {
            is FollowingRefreshAuth.SignedOut -> signOut()

            // Both remaining failures KEEP the content and deliberately do NOT redraw: there
            // is nothing new to show, and the card the launcher is already displaying is still
            // correct. Re-serialising this widget's bitmaps across the process boundary to
            // paint the same thing would be all of the cost of the outage and none of the
            // benefit.
            //
            // They DO log, at the level their outcome deserves. A widget that quietly stops
            // updating is the hardest thing to diagnose on this surface — there is no UI to
            // show an error in, by design — so the log is the only account of why, and a
            // silent branch here reads exactly like a worker that never ran.
            is FollowingRefreshAuth.RetryLater -> {
                Log.w(TAG, "No usable session yet; keeping the current rotation", auth.cause)
                Result.retry()
            }

            is FollowingRefreshAuth.GiveUp -> {
                Log.e(TAG, "The background token could not be read; keeping the rotation", auth.cause)
                Result.failure()
            }

            is FollowingRefreshAuth.Authorized -> refresh(auth)
        }
    }

    /**
     * Proven end of session: forget the timeline, then redraw.
     *
     * In THAT order, and it matters — the redraw is what replaces the posts on screen with the
     * signed-out card, so it has to happen after the store is empty or it would paint the very
     * content this is removing. `Result.success()` because nothing failed: the user is signed
     * out, and no retry can change that.
     *
     * No image work here, and no prune: what the cache holds is thumbnails keyed by URL, with
     * no post, no author and no account attached to them (see `FollowingImages`). It is the
     * ROTATION that names who this reader follows, and that is what is destroyed.
     *
     * UNCONDITIONAL, even though that means a bitmap-free redraw every periodic tick for as
     * long as the user stays signed out. Skipping the work when the store is "already empty"
     * would need to know that, and the only cheap way to ask — `read` — takes the account to
     * compare against, which is exactly what we do not have here: it would report a store full
     * of the PREVIOUS account's posts as empty and leave them on disk. A redundant clear costs
     * one DataStore edit; getting that backwards costs the whole privacy property.
     */
    private suspend fun signOut(): Result {
        Log.i(TAG, "No session for the following widget; clearing its stored timeline")
        FollowingStore.clear(applicationContext)
        FollowingWidget().updateAll(applicationContext)

        // The SECOND way the automatic turn can come back, and the only one that runs without
        // the user or the framework doing anything. `ensureAutoAdvance` keeps a live chain
        // untouched (`KEEP`), so on a healthy widget this costs nothing; where it earns its
        // line is a chain that ended — a cancelled job, a WorkManager database out of step with
        // JobScheduler after an app update, a link the system dropped under quota. The rotation
        // is the whole card now that the chevrons are gone (see `autoAdvanceTick`), so it
        // should not take a reboot to restart it.
        FollowingRefreshScheduler.ensureAutoAdvance(applicationContext)
        return Result.success()
    }

    private suspend fun refresh(auth: FollowingRefreshAuth.Authorized): Result {
        val stored = FollowingStore.read(applicationContext, auth.accountId)
        val now = System.currentTimeMillis()

        val outcome = if (shouldFetchRotation(stored, now)) {
            fetchInto(now, auth)
        } else {
            FollowingStore.advance(applicationContext)
            Result.success()
        }

        // Runs whatever happened above, including after a failed fetch: the post about to be
        // drawn is the one the rotation now points at, and it needs its pictures regardless of
        // whether this tick refreshed anything.
        cacheCurrentImages(auth.accountId)
        FollowingWidget().updateAll(applicationContext)
        return outcome
    }

    private suspend fun fetchInto(nowMs: Long, auth: FollowingRefreshAuth.Authorized): Result = try {
        val posts = FollowingApi.fetch(applicationContext, auth.accessToken)
        if (posts.isEmpty()) {
            // A 200 with nothing usable in it, which on THIS feed is an ordinary state: a
            // reader who follows nobody yet, or whose follows have not posted. Not retried and
            // not stored, so a widget that already has posts keeps them and a first run shows
            // the empty card.
            Log.w(TAG, "The following feed returned no drawable posts; keeping the rotation")
            Result.success()
        } else {
            FollowingStore.saveFetched(applicationContext, posts, nowMs, auth.accountId)
            FollowingImages.prune(
                applicationContext,
                rotationImageUrls(applicationContext, posts),
            )
            Result.success()
        }
    } catch (cause: IOException) {
        // Transient by nature — no network, a timeout, a 5xx, or a 401 on the feed itself
        // (which is ambiguous, not proof of a dead session; only the mint decides that).
        Log.w(TAG, "Could not refresh the following widget", cause)
        // Only worth retrying while there is nothing to show. Once the widget has content the
        // periodic tick is the next attempt, and backing off on a network that is still down
        // would wake the device to fail again.
        val firstRun = FollowingStore
            .read(applicationContext, auth.accountId)
            .posts
            .isEmpty()
        when {
            !firstRun -> Result.success()
            runAttemptCount >= MAX_ATTEMPTS -> Result.failure()
            else -> Result.retry()
        }
    } catch (cause: JSONException) {
        // The response was not the shape this build knows how to read. Retrying would fetch the
        // same body again, so it stops here and the widget keeps its last good content until
        // the contract is fixed.
        Log.e(TAG, "The following feed returned a body the widget cannot read", cause)
        Result.failure()
    }

    /**
     * Download the current post's avatar and image if they are not already cached.
     *
     * At most two small files, because only one post is on screen — that is the whole reason
     * the widget rotates instead of listing several posts with their attachments, which is the
     * shape that overruns a `RemoteViews`.
     */
    private suspend fun cacheCurrentImages(accountId: String) {
        val current = FollowingStore.read(applicationContext, accountId).current ?: return
        postImageUrls(applicationContext, current).forEach { url ->
            FollowingImages.ensureCached(applicationContext, url)
        }
    }

    private companion object {
        const val TAG = "MentionFollowingWidget"

        /**
         * Attempts before a first-run fetch gives up. `runAttemptCount` is zero-based, so this
         * allows the first try plus two retries; past that the periodic schedule is the next
         * opportunity anyway.
         */
        const val MAX_ATTEMPTS = 3
    }
}
