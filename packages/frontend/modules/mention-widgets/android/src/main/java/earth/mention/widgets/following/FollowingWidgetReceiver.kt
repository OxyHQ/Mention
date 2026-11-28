package earth.mention.widgets.following

import android.appwidget.AppWidgetManager
import android.content.Context
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver

/**
 * The following widget's manifest entry point, and the only place its ticks are started or
 * stopped.
 *
 * Tying the WorkManager jobs to these callbacks is what keeps the widget from costing anything
 * until someone uses one: nothing is scheduled before the first is placed, and nothing survives
 * the last one being removed. On this widget that also means no token is ever minted for a
 * reader who never placed it.
 */
class FollowingWidgetReceiver : GlanceAppWidgetReceiver() {

    override val glanceAppWidget: GlanceAppWidget = FollowingWidget()

    /** First widget placed: start both ticks and fill it immediately. */
    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        FollowingRefreshScheduler.ensureScheduled(context)
        FollowingRefreshScheduler.ensureAutoAdvance(context)
        FollowingRefreshScheduler.refreshNow(context)
    }

    /**
     * The system asking for a redraw — after a reboot, an app update, or a locale change.
     *
     * `ensureScheduled` is repeated here rather than left to `onEnabled` alone because
     * `onEnabled` fires once, ever, for the first instance: if WorkManager's own records are
     * lost (a "clear data", a restore onto a new device) there would otherwise be no second
     * chance to reschedule, and the widget would sit on one post forever.
     * `ExistingPeriodicWorkPolicy.KEEP` makes the repeat a no-op when the job is already there.
     *
     * The automatic-turn chain is restarted from here for a second reason: it deliberately
     * stops itself whenever the screen is off, rather than turning a widget nobody can see.
     * This is where it picks back up — `onUpdate` fires when the launcher comes back to a home
     * screen holding the widget — and `ExistingWorkPolicy.KEEP` is what stops a burst of
     * updates from forking the chain or resetting its delay forever.
     */
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        FollowingRefreshScheduler.ensureScheduled(context)
        FollowingRefreshScheduler.ensureAutoAdvance(context)
    }

    /**
     * Last one removed: stop every job, and FORGET THE TIMELINE.
     *
     * The clear is what makes removing the widget a complete withdrawal of consent rather than
     * just a change to the home screen. Nothing would read that store again while no widget
     * exists, so this is not protecting a render — it is not keeping one person's private
     * reading on disk after they took the surface that displayed it away.
     *
     * It is fire-and-forget on the store's own scope because `onDisabled` is a broadcast
     * callback with no coroutine scope and seconds to return; a DataStore edit is a small
     * append that does not need to be awaited here. The jobs are cancelled first so nothing can
     * write the rotation back after it is gone.
     */
    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        FollowingRefreshScheduler.cancel(context)
        FollowingRefreshScheduler.forgetRotation(context)
    }
}
