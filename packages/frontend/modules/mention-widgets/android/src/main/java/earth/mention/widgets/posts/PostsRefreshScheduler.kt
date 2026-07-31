package earth.mention.widgets.posts

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkRequest
import earth.mention.widgets.R
import java.util.concurrent.TimeUnit

/**
 * When the trending-posts widget ticks — ALL of its WorkManager in one place.
 *
 * Its own schedule, separate from the trends widgets': this one both rotates and fetches,
 * on a shorter interval than a trends refresh needs, and the two families are placed
 * independently — a user with only a posts widget must not be paying for a trends fetch,
 * and the reverse.
 *
 * THREE PIECES OF WORK, on deliberately different clocks:
 *
 *  - the PERIODIC tick ([ensureScheduled]) — fetch and rotate, every fifteen minutes, which
 *    is WorkManager's floor for periodic work;
 *  - an IMMEDIATE run ([refreshNow]) — so a freshly placed widget fills in seconds;
 *  - the ROTATION chain ([ensureRotating] / [restartRotation]) — a self-rescheduling
 *    one-time request every twenty-odd seconds, which is the only way under that floor, and
 *    the only reason a reader ever sees the card turn over.
 *
 * Scheduling is tied to the widget's own lifecycle — started when one is placed, cancelled
 * when the last is removed — so a user who never adds the widget never pays for it. That is
 * also why [cancel] iterates [ALL_WORK_NAMES] rather than naming each one: a fourth kind of
 * work added to this object without a line in that list would outlive the widget it belongs
 * to, and this module holds itself to leaking no workers.
 */
internal object PostsRefreshScheduler {
    const val PERIODIC_WORK_NAME = "mention-widget-posts-periodic"
    const val IMMEDIATE_WORK_NAME = "mention-widget-posts-immediate"
    const val ROTATION_WORK_NAME = "mention-widget-posts-rotation"

    /**
     * Every unique work name this widget enqueues, and therefore everything [cancel] has to
     * take away with it. Add a new kind of work above, add it here.
     */
    val ALL_WORK_NAMES = listOf(PERIODIC_WORK_NAME, IMMEDIATE_WORK_NAME, ROTATION_WORK_NAME)

    /**
     * How often the job runs.
     *
     * Fifteen minutes is WorkManager's own floor for periodic work
     * (`PeriodicWorkRequest.MIN_PERIODIC_INTERVAL_MILLIS`), and it is the rotation's pace
     * rather than the fetch's: each run advances to the next post, and only a run that
     * finds the batch older than `FETCH_INTERVAL_MS` goes to the network. So five posts
     * cycle in an hour and a quarter while `/feed/mtn` is called twice an hour.
     */
    private const val TICK_INTERVAL_MINUTES = 15L

    /**
     * The window WorkManager may run the job in at the end of each interval.
     *
     * Five minutes — a third of the interval, where the trends refresh allows a third of
     * its own. It lets the scheduler batch this wake-up with whatever else the device is
     * already doing rather than firing an alarm of its own; the rotation is not a clock and
     * nothing depends on the exact moment it turns over.
     */
    private const val TICK_FLEX_MINUTES = 5L

    private val NETWORK_REQUIRED = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    /**
     * Start the periodic tick, or leave a running one alone.
     *
     * [ExistingPeriodicWorkPolicy.KEEP] is what makes this safe to call from every
     * `onUpdate`: re-enqueuing with REPLACE would restart the interval on each system
     * update, and a widget that is updated often enough could then never reach the end of a
     * period — it would neither rotate nor fetch.
     */
    fun ensureScheduled(context: Context) {
        val request = PeriodicWorkRequestBuilder<PostsRefreshWorker>(
            TICK_INTERVAL_MINUTES, TimeUnit.MINUTES,
            TICK_FLEX_MINUTES, TimeUnit.MINUTES,
        )
            .setConstraints(NETWORK_REQUIRED)
            .setBackoffCriteria(
                BackoffPolicy.EXPONENTIAL,
                WorkRequest.MIN_BACKOFF_MILLIS,
                TimeUnit.MILLISECONDS,
            )
            .build()

        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(PERIODIC_WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /**
     * Tick now — used when a widget has just been placed, so it fills with content in
     * seconds instead of at the end of the first period.
     *
     * [ExistingWorkPolicy.REPLACE] collapses a burst into one run, which matters because
     * placing two widgets at once fires `onEnabled` and `onUpdate` in quick succession.
     */
    fun refreshNow(context: Context) {
        val request = OneTimeWorkRequestBuilder<PostsRefreshWorker>()
            .setConstraints(NETWORK_REQUIRED)
            .setBackoffCriteria(
                BackoffPolicy.EXPONENTIAL,
                WorkRequest.MIN_BACKOFF_MILLIS,
                TimeUnit.MILLISECONDS,
            )
            .build()

        WorkManager.getInstance(context)
            .enqueueUniqueWork(IMMEDIATE_WORK_NAME, ExistingWorkPolicy.REPLACE, request)
    }

    /**
     * Start the rotation chain, and leave a running one alone.
     *
     * [ExistingWorkPolicy.KEEP] is what makes this safe to call from every `onUpdate` and
     * from the refresh tick: re-enqueuing with REPLACE on each of those would restart the
     * delay every time, and a widget updated often enough would never reach the end of one.
     *
     * This is also how the chain comes back after the screen has been off. A link that finds
     * the device asleep ends the chain rather than cycling in a pocket, so something has to
     * start it again — `onUpdate`, the fifteen-minute refresh tick, or a tap. That means
     * rotation can take until the next refresh tick to resume after a long screen-off, which
     * is the honest cost of not waking the device to animate something nobody can see.
     */
    fun ensureRotating(context: Context) {
        enqueueRotation(context, ExistingWorkPolicy.KEEP)
    }

    /**
     * Start the rotation timer over from now.
     *
     * Two callers, both of which mean "the clock restarts here": the chain's own next link,
     * and a READER'S TAP. The tap matters — without the reset, a card tapped a second before
     * a rotation was due would jump again immediately, moving under the finger that had just
     * asked for something specific.
     */
    fun restartRotation(context: Context) {
        enqueueRotation(context, ExistingWorkPolicy.REPLACE)
    }

    /**
     * One link of the rotation chain, due in [rotationIntervalSeconds].
     *
     * NO CONSTRAINTS, unlike the two fetching requests: advancing reads the store that the
     * last fetch already filled, so the rotation keeps working on a phone with no signal —
     * requiring a network here would stop the card moving for the exact reason it has content
     * to move through.
     *
     * No backoff criteria either. There is nothing to retry: a link that cannot do its work
     * ends the chain, and the next `onUpdate` or refresh tick starts a new one.
     */
    private fun enqueueRotation(context: Context, policy: ExistingWorkPolicy) {
        val request = OneTimeWorkRequestBuilder<PostsRotationWorker>()
            .setInitialDelay(
                rotationIntervalSeconds(
                    context.resources.getInteger(R.integer.mention_posts_widget_rotate_seconds),
                ),
                TimeUnit.SECONDS,
            )
            .build()

        WorkManager.getInstance(context).enqueueUniqueWork(ROTATION_WORK_NAME, policy, request)
    }

    /**
     * Called when the last trending-posts widget is removed from the home screen.
     *
     * Iterates [ALL_WORK_NAMES] so that nothing this object can enqueue can survive the
     * widget it was enqueued for — including a rotation link that is already counting down.
     */
    fun cancel(context: Context) {
        val workManager = WorkManager.getInstance(context)
        ALL_WORK_NAMES.forEach { name -> workManager.cancelUniqueWork(name) }
    }
}
