package earth.mention.widgets.following

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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

/**
 * When the following widget ticks — ALL of its WorkManager in one place.
 *
 * Its own schedule and its own unique work names, separate from the trending widget's, because
 * the two are placed independently: a user with only one of them must not be paying for the
 * other's fetch. Sharing a name would be worse than wasteful — `enqueueUniqueWork` would have
 * each widget's scheduling cancel the other's.
 *
 * Scheduling is tied to the widget's own lifecycle — started when one is placed, cancelled when
 * the last is removed — so a reader who never adds the widget never pays for it, and no token
 * is ever minted on their behalf.
 */
internal object FollowingRefreshScheduler {
    private const val PERIODIC_WORK_NAME = "mention-widget-following-periodic"
    private const val IMMEDIATE_WORK_NAME = "mention-widget-following-immediate"

    /**
     * The automatic-turn chain's unique name.
     *
     * One name for every link, which is what makes the chain a chain: `enqueueUniqueWork`
     * against it can never leave two pending turns, however many callers ask.
     */
    private const val AUTO_ADVANCE_WORK_NAME = "mention-widget-following-auto-advance"

    /**
     * Every unique work name this object can enqueue, and therefore everything [cancel] has to
     * take away with it.
     *
     * A list rather than three calls, because the failure it prevents is silent: a fourth kind
     * of work added above without a line here would outlive the widget it belongs to, and a
     * self-rescheduling chain that outlives its widget never stops.
     */
    private val ALL_WORK_NAMES =
        listOf(PERIODIC_WORK_NAME, IMMEDIATE_WORK_NAME, AUTO_ADVANCE_WORK_NAME)

    /**
     * How often the job runs.
     *
     * Fifteen minutes is WorkManager's own floor for periodic work
     * (`PeriodicWorkRequest.MIN_PERIODIC_INTERVAL_MILLIS`), and it is the rotation's pace rather
     * than the fetch's: each run advances to the next post, and only a run that finds the batch
     * older than `FETCH_INTERVAL_MS` goes to the network.
     */
    private const val TICK_INTERVAL_MINUTES = 15L

    /**
     * The window WorkManager may run the job in at the end of each interval.
     *
     * Five minutes — a third of the interval. It lets the scheduler batch this wake-up with
     * whatever else the device is already doing rather than firing an alarm of its own; the
     * rotation is not a clock and nothing depends on the exact moment it turns over.
     */
    private const val TICK_FLEX_MINUTES = 5L

    private val NETWORK_REQUIRED = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    /**
     * The scope [forgetRotation] runs on.
     *
     * `onDisabled` is a broadcast callback with no scope of its own and seconds to return, and
     * the write it needs is a small DataStore edit. `SupervisorJob` so a failure here can never
     * cancel a sibling launch; `Dispatchers.IO` because DataStore writes to a file.
     */
    private val storeScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * Start the periodic tick, or leave a running one alone.
     *
     * [ExistingPeriodicWorkPolicy.KEEP] is what makes this safe to call from every `onUpdate`:
     * re-enqueuing with REPLACE would restart the interval on each system update, and a widget
     * that is updated often enough could then never reach the end of a period — it would neither
     * rotate nor fetch.
     */
    fun ensureScheduled(context: Context) {
        val request = PeriodicWorkRequestBuilder<FollowingRefreshWorker>(
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
     * Tick now — used when a widget has just been placed, so it fills with content in seconds
     * instead of at the end of the first period.
     *
     * [ExistingWorkPolicy.REPLACE] collapses a burst into one run, which matters because placing
     * two widgets at once fires `onEnabled` and `onUpdate` in quick succession — and on this
     * widget each run can cost a token mint.
     */
    fun refreshNow(context: Context) {
        val request = OneTimeWorkRequestBuilder<FollowingRefreshWorker>()
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
     * Queue the next automatic turn, keeping one already queued.
     *
     * [ExistingWorkPolicy.KEEP] is the whole safety property of the chain: `onUpdate` fires often
     * — after a reboot, an app update, a locale change, every periodic tick — and REPLACE would
     * restart the delay each time, so a frequently-updated widget would never reach the end of
     * one. KEEP also means the chain cannot fork: a second call while a link is pending is a
     * no-op rather than a second chain advancing the same rotation twice as fast.
     *
     * No network constraint, deliberately — a step reads the batch already in the store and needs
     * no session at all, so requiring connectivity would stop the rotation on a plane for no
     * reason.
     */
    fun ensureAutoAdvance(context: Context) {
        enqueueAutoAdvance(context, ExistingWorkPolicy.KEEP)
    }

    /**
     * What [FollowingAutoAdvanceWorker] calls to continue the chain.
     *
     * Distinct from [ensureAutoAdvance] only in policy: the link that just ran is finished, so
     * KEEP would have nothing to keep, and being explicit about REPLACE here documents that
     * this is the one caller allowed to restart the clock unconditionally.
     */
    fun scheduleNextAutoAdvance(context: Context) {
        enqueueAutoAdvance(context, ExistingWorkPolicy.REPLACE)
    }

    private fun enqueueAutoAdvance(context: Context, policy: ExistingWorkPolicy) {
        val seconds = context.resources
            .getInteger(R.integer.mention_following_widget_auto_advance_seconds)
            .toLong()
        val request = OneTimeWorkRequestBuilder<FollowingAutoAdvanceWorker>()
            .setInitialDelay(seconds, TimeUnit.SECONDS)
            .build()

        WorkManager.getInstance(context)
            .enqueueUniqueWork(AUTO_ADVANCE_WORK_NAME, policy, request)
    }

    /** Called when the last following widget is removed from the home screen. */
    fun cancel(context: Context) {
        val workManager = WorkManager.getInstance(context)
        ALL_WORK_NAMES.forEach { name -> workManager.cancelUniqueWork(name) }
    }

    /**
     * Drop the stored timeline, because the last widget showing it is gone.
     *
     * Detached rather than awaited, for the reason given on [storeScope]. It is enqueued AFTER
     * [cancel] so no surviving job can write the rotation back after it has been dropped.
     */
    fun forgetRotation(context: Context) {
        val appContext = context.applicationContext
        storeScope.launch { FollowingStore.clear(appContext) }
    }
}
