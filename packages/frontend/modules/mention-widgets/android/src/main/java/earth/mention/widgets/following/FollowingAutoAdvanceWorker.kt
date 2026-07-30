package earth.mention.widgets.following

import android.content.Context
import android.os.PowerManager
import androidx.core.content.getSystemService
import androidx.glance.appwidget.updateAll
import earth.mention.widgets.feedcard.autoAdvanceTick
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * Turns the following rotation over on its own, fast enough to be seen.
 *
 * The same mechanism, and the same reasoning, as the trending widget's chain: `PeriodicWork` is
 * floored at fifteen minutes, nobody watching a home screen ever sees a fifteen-minute turn, and
 * `RemoteViews` has no gestures — so an automatic turn is the only way a reader sees more than
 * one of the five posts. A chain of ONE-TIME requests takes an arbitrary `setInitialDelay` and is
 * therefore not subject to the floor.
 *
 * ADVANCING NEEDS NO SESSION AND NO NETWORK, which is what makes this cheap here specifically:
 * the batch is already in the store, so a step is a position write and a redraw. It costs no
 * token mint, and it keeps working while the device is offline.
 *
 * The interval — `mention_following_widget_auto_advance_seconds`, thirty by default — is set by
 * what a redraw costs: this widget's `RemoteViews` carries decoded bitmaps (see
 * `FeedCardBitmaps.kt`), so each turn re-serialises them across the process boundary.
 *
 * IT STOPS BY NOT RESCHEDULING. There is no visibility signal for a widget — no AppWidget or
 * Glance callback says "you are on screen" — so the closest available proxy is whether the device
 * is interactive at all. When it is not, this link simply does not enqueue another and the chain
 * is over; `onUpdate` starts it again when the launcher comes back.
 */
internal class FollowingAutoAdvanceWorker(
    context: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(context, parameters) {

    override suspend fun doWork(): Result {
        val power = applicationContext.getSystemService<PowerManager>()
        val tick = autoAdvanceTick(screenInteractive = power?.isInteractive == true)

        if (tick.advance) {
            FollowingStore.advance(applicationContext)
            FollowingWidget().updateAll(applicationContext)
        }
        if (tick.rearm) {
            FollowingRefreshScheduler.scheduleNextAutoAdvance(applicationContext)
        }
        return Result.success()
    }
}
