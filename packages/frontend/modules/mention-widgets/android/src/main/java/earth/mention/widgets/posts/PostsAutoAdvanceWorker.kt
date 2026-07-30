package earth.mention.widgets.posts

import android.content.Context
import android.os.PowerManager
import androidx.core.content.getSystemService
import androidx.glance.appwidget.updateAll
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * Turns the rotation over on its own, fast enough to be seen.
 *
 * ## Why this exists next to `PostsRefreshWorker`
 *
 * `PostsRefreshWorker` also advances, but it is periodic work and WorkManager floors that at
 * fifteen minutes (`PeriodicWorkRequest.MIN_PERIODIC_INTERVAL_MILLIS`; the provider's own
 * `updatePeriodMillis` is clamped to thirty). Nobody looking at their home screen ever sees
 * a fifteen-minute turn, so the rotation read as broken — and with swiping impossible on this
 * surface, automatic movement is the only way more than one post is ever seen.
 *
 * The opening is that **advancing costs no network**: the batch is already in the store, so a
 * step is a position write and a redraw. That decouples the two cadences entirely — the fetch
 * stays on its fifteen-minute periodic tick, and this rides a chain of ONE-TIME requests,
 * which take an arbitrary `setInitialDelay` and are therefore not subject to the floor.
 *
 * ## What it costs, honestly
 *
 * A redraw is not free: this widget's `RemoteViews` carries decoded bitmaps (see
 * `PostsBitmapBudget.kt`), so each turn re-serialises them to the launcher. That is what sets
 * the interval — `mention_posts_widget_auto_advance_seconds`, thirty by default, long enough
 * to be worth a glance and short enough to be seen during one. Five seconds would look
 * livelier and would push bitmaps across the process boundary twelve times a minute for a
 * widget nobody is necessarily looking at.
 *
 * Which is the honest limitation: **there is no visibility signal for a widget.** No
 * AppWidget or Glance callback says "you are on screen", so the closest available proxy is
 * whether the device is interactive at all — the user may well be in another app. Doze and
 * app-standby will throttle the chain when the screen is off, and that is correct behaviour
 * to leave alone rather than defeat with an exact alarm.
 */
internal class PostsAutoAdvanceWorker(
    context: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(context, parameters) {

    override suspend fun doWork(): Result {
        // Screen off: step nothing and, crucially, do not re-enqueue. Cycling a widget that
        // cannot be seen is pure battery. The chain restarts from the next real update —
        // `onUpdate` fires when the screen comes back to a home screen holding the widget.
        val power = applicationContext.getSystemService<PowerManager>()
        if (power?.isInteractive != true) return Result.success()

        PostsRepository.advance(applicationContext)
        PostsWidget().updateAll(applicationContext)
        PostsRefreshScheduler.scheduleNextAutoAdvance(applicationContext)
        return Result.success()
    }
}
