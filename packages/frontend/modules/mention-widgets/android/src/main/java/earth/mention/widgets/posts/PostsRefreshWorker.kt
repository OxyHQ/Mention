package earth.mention.widgets.posts

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.util.Log
import androidx.glance.appwidget.updateAll
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import org.json.JSONException
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * The trending-posts widget's one background job: advance the rotation, fetch when the
 * batch is stale, and make sure every post in the rotation has its images on disk.
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
        if (!anyPlaced(applicationContext)) {
            return Result.success()
        }

        val stored = PostsRepository.read(applicationContext)
        val now = System.currentTimeMillis()

        val outcome = if (shouldFetchRotation(stored, now)) {
            fetchInto(now)
        } else {
            PostsRepository.advance(applicationContext)
            Result.success()
        }

        // Runs whatever happened above, including after a failed fetch: the rotation still
        // points somewhere, and it needs its pictures — the one being drawn now, and the ones
        // a reader can reach with the advance control — regardless of whether this tick
        // refreshed anything.
        cacheRotationImages()
        PostsWidget().updateAll(applicationContext)
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
            PostsRepository.saveFetched(applicationContext, posts, nowMs)
            PostsImageCache.prune(
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
        val firstRun = PostsRepository.read(applicationContext).posts.isEmpty()
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
     * Download the images the rotation needs, THE POST ON SCREEN FIRST.
     *
     * The whole rotation rather than only the current post, and that is the reader's tap
     * paying for itself: the advance control moves the cursor at a moment nothing schedules,
     * and a post whose picture had not been downloaded yet would draw without one — a card
     * that looks broken in a new way, in answer to a press. The tap itself cannot fetch
     * anything, since an `ActionCallback` runs inside a broadcast with seconds to finish, so
     * the pictures have to be here before it happens.
     *
     * Still small, and still bounded by the rotation: ten files at the very most, an avatar
     * and a thumbnail for each of five posts, of tens of kilobytes each. `ensureCached` never
     * re-downloads what is already on disk, so every tick after the one that fetched costs a
     * handful of file checks. `PostsImageCache.prune` already keeps exactly this set, so
     * nothing accumulates.
     *
     * The current post leads the list because it is the one the launcher is about to draw;
     * the rest are ready for a press. Ordering it this way is also what makes a tick that is
     * cut short by the system leave the visible card correct.
     */
    private suspend fun cacheRotationImages() {
        val rotation = PostsRepository.read(applicationContext)
        val current = rotation.current
        val urls = if (current == null) {
            rotationImageUrls(applicationContext, rotation.posts)
        } else {
            postImageUrls(applicationContext, current) +
                rotationImageUrls(applicationContext, rotation.posts)
        }
        urls.distinct().forEach { url ->
            PostsImageCache.ensureCached(applicationContext, url)
        }
    }

    private companion object {
        const val TAG = "MentionPostsWidget"

        /**
         * Attempts before a first-run fetch gives up. `runAttemptCount` is zero-based, so
         * this allows the first try plus two retries; past that the periodic schedule is
         * the next opportunity anyway.
         */
        const val MAX_ATTEMPTS = 3
    }
}

/**
 * How old the stored batch has to be before a tick re-fetches it instead of just rotating.
 *
 * Half an hour. Explore is a ranked discovery feed rather than a live timeline, so its top
 * five turn over on the order of hours; polling it on every fifteen-minute tick would spend
 * four times the requests to receive largely the same five posts.
 */
internal val FETCH_INTERVAL_MS = TimeUnit.MINUTES.toMillis(30)

/**
 * Whether this tick should go to the network, or just move the rotation on.
 *
 * A top-level function rather than a method because it is the decision that gives this
 * widget its whole behaviour — rotate four times an hour, fetch twice — and a `Worker`
 * method cannot be unit tested without a `Context`.
 *
 * A rotation that has never been fetched always fetches. Otherwise it is a question of age,
 * and the future-timestamp guard is not paranoia: `currentTimeMillis` moves backwards
 * whenever the clock is corrected or a time zone changes, and without the absolute value a
 * widget could conclude its content was fetched hours from now and stop refreshing until
 * real time caught up.
 */
internal fun shouldFetchRotation(stored: PostsRotation, nowMs: Long): Boolean {
    if (stored.posts.isEmpty()) return true
    return abs(nowMs - stored.fetchedAtMs) >= FETCH_INTERVAL_MS
}

/**
 * Whether a trending-posts widget is on a home screen at all.
 *
 * Asked of `AppWidgetManager` rather than of Glance because the answer is needed
 * synchronously, and there is one provider to ask about — unlike the trends family, whose
 * three variants share a schedule and have to be asked about together.
 */
internal fun anyPlaced(context: Context): Boolean {
    // Null where the device has no app-widget host at all (some TV and automotive
    // builds); nothing is placed there by definition.
    val manager = AppWidgetManager.getInstance(context) ?: return false
    return manager
        .getAppWidgetIds(ComponentName(context, PostsWidgetReceiver::class.java))
        .isNotEmpty()
}
