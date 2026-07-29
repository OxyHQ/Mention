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
import java.util.concurrent.TimeUnit

/**
 * When the trending-posts widget ticks.
 *
 * Its own schedule, separate from the trends widgets': this one both rotates and fetches,
 * on a shorter interval than a trends refresh needs, and the two families are placed
 * independently — a user with only a posts widget must not be paying for a trends fetch,
 * and the reverse.
 *
 * Scheduling is tied to the widget's own lifecycle — started when one is placed, cancelled
 * when the last is removed — so a user who never adds the widget never pays for it.
 */
internal object PostsRefreshScheduler {
    private const val PERIODIC_WORK_NAME = "mention-widget-posts-periodic"
    private const val IMMEDIATE_WORK_NAME = "mention-widget-posts-immediate"

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

    /** Called when the last trending-posts widget is removed from the home screen. */
    fun cancel(context: Context) {
        val workManager = WorkManager.getInstance(context)
        workManager.cancelUniqueWork(PERIODIC_WORK_NAME)
        workManager.cancelUniqueWork(IMMEDIATE_WORK_NAME)
    }
}
