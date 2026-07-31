package earth.mention.widgets.trends

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
 * When the trends widget goes and gets new data.
 *
 * Scheduling is tied to the widget's own lifecycle — started the first time one
 * is placed, cancelled when the last is removed — so a user who never adds the
 * widget never pays for it.
 */
internal object TrendsRefreshScheduler {
    private const val PERIODIC_WORK_NAME = "mention-widget-trends-periodic"
    private const val IMMEDIATE_WORK_NAME = "mention-widget-trends-immediate"

    /**
     * The backend recomputes the trending batch every 30 minutes
     * (`CALCULATION_INTERVAL` in packages/backend/src/services/TrendingService.ts),
     * so this is the point at which there is something new to fetch — polling
     * faster would spend battery on a response that cannot have changed.
     */
    private const val REFRESH_INTERVAL_MINUTES = 30L

    /**
     * The window WorkManager may run the job in at the end of each interval.
     * Giving it ten minutes of slack lets the scheduler batch this wake-up with
     * whatever else the device is already doing rather than firing its own alarm.
     */
    private const val REFRESH_FLEX_MINUTES = 10L

    private val NETWORK_REQUIRED = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    /**
     * Start the periodic refresh, or leave a running one alone.
     *
     * [ExistingPeriodicWorkPolicy.KEEP] is what makes this safe to call from
     * every `onUpdate`: re-enqueuing with REPLACE would restart the interval on
     * each system update and the job could end up never reaching the end of a
     * period.
     */
    fun ensureScheduled(context: Context) {
        val request = PeriodicWorkRequestBuilder<TrendsRefreshWorker>(
            REFRESH_INTERVAL_MINUTES, TimeUnit.MINUTES,
            REFRESH_FLEX_MINUTES, TimeUnit.MINUTES,
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
     * Fetch now — used when a widget has just been placed, and when the app has
     * seen the batch rotate while the user was looking at it.
     *
     * [ExistingWorkPolicy.REPLACE] collapses a burst of nudges into one fetch.
     */
    fun refreshNow(context: Context) {
        val request = OneTimeWorkRequestBuilder<TrendsRefreshWorker>()
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

    /** Called when the last trends widget is removed from the home screen. */
    fun cancel(context: Context) {
        val workManager = WorkManager.getInstance(context)
        workManager.cancelUniqueWork(PERIODIC_WORK_NAME)
        workManager.cancelUniqueWork(IMMEDIATE_WORK_NAME)
    }
}
