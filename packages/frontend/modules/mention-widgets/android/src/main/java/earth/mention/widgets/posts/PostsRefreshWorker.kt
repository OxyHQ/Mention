package earth.mention.widgets.posts

import android.content.Context
import android.util.Log
import androidx.glance.appwidget.updateAll
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import earth.mention.widgets.feedcard.FETCH_INTERVAL_MS
import earth.mention.widgets.feedcard.anyPlaced
import earth.mention.widgets.feedcard.rotationImageUrls
import earth.mention.widgets.feedcard.shouldFetchRotation
import org.json.JSONException
import java.io.IOException

/**
 * The trending-posts widget's one background job: advance the rotation, fetch when the
 * batch is stale, and make sure the post about to be drawn has its images on disk.
 *
 * ROTATING AND FETCHING ARE THE SAME TICK, at different rates. The job runs on the
 * shortest interval WorkManager offers and moves the rotation on every run, but only
 * re-fetches once the stored batch is older than [FETCH_INTERVAL_MS] — so the widget
 * visibly changes four times an hour while the network is touched twice. Two separate
 * periodic jobs would have cost two wake-ups to achieve the same thing.
 *
 * The failure contract has one rule: this worker never writes an empty or partial
 * rotation. A fetch that does not produce a parsed list leaves the store exactly as it
 * was, and the rotation still advances — so a phone that has been offline for a day shows
 * yesterday's posts, cycling, rather than a blank box.
 */
internal class PostsRefreshWorker(
    appContext: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(appContext, parameters) {

    override suspend fun doWork(): Result {
        // The periodic job is cancelled when the last widget is removed, but a run can
        // already be queued when that happens, and a one-off nudge from JS does not know
        // whether the user has a widget at all. Checking here covers both without either
        // caller having to.
        if (!anyPlaced(applicationContext, PostsWidgetReceiver::class.java)) {
            return Result.success()
        }

        val stored = PostsStore.read(applicationContext, POSTS_ACCOUNT_ID)
        val now = System.currentTimeMillis()

        val outcome = if (shouldFetchRotation(stored, now)) {
            fetchInto(now)
        } else {
            PostsStore.advance(applicationContext)
            Result.success()
        }

        // Runs whatever happened above, including after a failed fetch: the post about to
        // be drawn is the one the rotation now points at, and it needs its pictures
        // regardless of whether this tick refreshed anything.
        cacheRotationImages()
        PostsWidget().updateAll(applicationContext)

        // The SECOND way the automatic turn can come back, and the only one that runs without
        // the user or the framework doing anything. `ensureAutoAdvance` keeps a live chain
        // untouched (`KEEP`), so on a healthy widget this costs nothing; where it earns its
        // line is a chain that ended — a cancelled job, a WorkManager database out of step with
        // JobScheduler after an app update, a link the system dropped under quota. The rotation
        // is the whole card now that the chevrons are gone (see `autoAdvanceTick`), so it
        // should not take a reboot to restart it.
        PostsRefreshScheduler.ensureAutoAdvance(applicationContext)
        return outcome
    }

    private suspend fun fetchInto(nowMs: Long): Result = try {
        val posts = PostsApi.fetch(applicationContext)
        if (posts.isEmpty()) {
            // A 200 with nothing usable in it. Not retried — the response was well-formed,
            // so another attempt gets the same thing — and not stored either, so whatever
            // the widget is already showing stays.
            Log.w(TAG, "Explore returned no drawable posts; keeping the current rotation")
            Result.success()
        } else {
            PostsStore.saveFetched(applicationContext, posts, nowMs, POSTS_ACCOUNT_ID)
            PostsImages.prune(
                applicationContext,
                rotationImageUrls(applicationContext, posts),
            )
            Result.success()
        }
    } catch (cause: IOException) {
        // Transient by nature — no network, a timeout, a 5xx.
        Log.w(TAG, "Could not refresh the trending-posts widget", cause)
        // Only worth retrying while there is nothing to show. Once the widget has content
        // the periodic tick is the next attempt, and backing off on a network that is
        // still down would wake the device to fail again.
        val firstRun = PostsStore.read(applicationContext, POSTS_ACCOUNT_ID).posts.isEmpty()
        when {
            !firstRun -> Result.success()
            runAttemptCount >= MAX_ATTEMPTS -> Result.failure()
            else -> Result.retry()
        }
    } catch (cause: JSONException) {
        // The response was not the shape this build knows how to read. Retrying would
        // fetch the same body again, so it stops here and the widget keeps its last good
        // content until the contract is fixed.
        Log.e(TAG, "Explore returned a body the widget cannot read", cause)
        Result.failure()
    }

    /**
     * Download every picture the ROTATION needs, not just the one on screen.
     *
     * It used to fetch only the current post's two files, on the reasoning that one post is
     * visible at a time. That reasoning describes the `RemoteViews` payload, which is a real
     * constraint, and it does not describe the DISK cache, which has none — and the rotation
     * turns over every thirty seconds without any fetch of its own. So each turn revealed a
     * post whose avatar and picture nobody had downloaded, and the card drew a byline with no
     * avatar until a refresh a quarter of an hour later happened to land on it. That is the
     * "some posts load without an avatar" report, and it was never about those users.
     *
     * `rotationImageUrls` was already the set the cache is allowed to KEEP, and its own doc
     * said images "arrive lazily as the rotation reaches each post" — nothing ever made them
     * arrive. Fetching the same set closes that gap and makes the sets identical, so the cache
     * can no longer evict something the rotation is about to want.
     *
     * At most ten small files once per refresh: five avatars of about 1.6KB and up to five
     * pictures. Failures are per-file and silent by design — a picture that will not download
     * costs that card its picture, never the card.
     */
    private suspend fun cacheRotationImages() {
        val posts = PostsStore.read(applicationContext, POSTS_ACCOUNT_ID).posts
        rotationImageUrls(applicationContext, posts).forEach { url ->
            PostsImages.ensureCached(applicationContext, url)
        }
    }

    private companion object {
        const val TAG = "MentionFeedWidget"

        /**
         * Attempts before a first-run fetch gives up. `runAttemptCount` is zero-based, so
         * this allows the first try plus two retries; past that the periodic schedule is
         * the next opportunity anyway.
         */
        const val MAX_ATTEMPTS = 3
    }
}
