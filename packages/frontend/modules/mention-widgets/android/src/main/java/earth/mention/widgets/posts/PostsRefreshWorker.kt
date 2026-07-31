package earth.mention.widgets.posts

<<<<<<< HEAD
=======
import android.appwidget.AppWidgetManager
import android.content.ComponentName
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
import android.content.Context
import android.util.Log
import androidx.glance.appwidget.updateAll
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
<<<<<<< HEAD
import earth.mention.widgets.feedcard.FETCH_INTERVAL_MS
import earth.mention.widgets.feedcard.anyPlaced
import earth.mention.widgets.feedcard.rotationImageUrls
import earth.mention.widgets.feedcard.shouldFetchRotation
import org.json.JSONException
import java.io.IOException

/**
 * The trending-posts widget's one background job: advance the rotation, fetch when the
 * batch is stale, and make sure the post about to be drawn has its images on disk.
=======
import org.json.JSONException
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * The trending-posts widget's one background job: advance the rotation, fetch when the
 * batch is stale, and make sure every post in the rotation has its images on disk.
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
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
<<<<<<< HEAD
        if (!anyPlaced(applicationContext, PostsWidgetReceiver::class.java)) {
            return Result.success()
        }

        val stored = PostsStore.read(applicationContext, POSTS_ACCOUNT_ID)
=======
        if (!anyPlaced(applicationContext)) {
            return Result.success()
        }

        val stored = PostsRepository.read(applicationContext)
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
        val now = System.currentTimeMillis()

        val outcome = if (shouldFetchRotation(stored, now)) {
            fetchInto(now)
        } else {
<<<<<<< HEAD
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
=======
            PostsRepository.advance(applicationContext)
            Result.success()
        }

        // Runs whatever happened above, including after a failed fetch: the rotation still
        // points somewhere, and it needs its pictures — the one being drawn now, and the ones
        // a reader can reach with the advance control — regardless of whether this tick
        // refreshed anything.
        cacheRotationImages()
        PostsWidget().updateAll(applicationContext)
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
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
<<<<<<< HEAD
            PostsStore.saveFetched(applicationContext, posts, nowMs, POSTS_ACCOUNT_ID)
            PostsImages.prune(
=======
            PostsRepository.saveFetched(applicationContext, posts, nowMs)
            PostsImageCache.prune(
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
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
<<<<<<< HEAD
        val firstRun = PostsStore.read(applicationContext, POSTS_ACCOUNT_ID).posts.isEmpty()
=======
        val firstRun = PostsRepository.read(applicationContext).posts.isEmpty()
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
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
<<<<<<< HEAD
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
=======
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
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
        }
    }

    private companion object {
<<<<<<< HEAD
        const val TAG = "MentionFeedWidget"
=======
        const val TAG = "MentionPostsWidget"
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)

        /**
         * Attempts before a first-run fetch gives up. `runAttemptCount` is zero-based, so
         * this allows the first try plus two retries; past that the periodic schedule is
         * the next opportunity anyway.
         */
        const val MAX_ATTEMPTS = 3
    }
}
<<<<<<< HEAD
=======

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
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
