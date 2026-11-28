package earth.mention.widgets.trends

import android.appwidget.AppWidgetManager
import android.content.Context
import androidx.glance.appwidget.GlanceAppWidgetReceiver

/**
 * The manifest entry point shared by the three trends widgets, and the only place
 * their refresh schedule is started or stopped.
 *
 * Tying the WorkManager job to these callbacks is what keeps the widgets from
 * costing anything until someone uses one: nothing is scheduled before the first is
 * placed, and nothing survives the last one being removed.
 *
 * ONE schedule feeds all three variants — they draw the same store — so the
 * lifecycle callbacks have to reason about the whole family rather than about the
 * variant they fired for. That is what [onDisabled] is careful about.
 */
abstract class TrendsWidgetReceiver : GlanceAppWidgetReceiver() {

    /** First widget of this variant placed: start the schedule and fill it immediately. */
    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        TrendsRefreshScheduler.ensureScheduled(context)
        TrendsRefreshScheduler.refreshNow(context)
    }

    /**
     * The system asking for a redraw — after a reboot, an app update, or a locale
     * change.
     *
     * `ensureScheduled` is repeated here rather than left to `onEnabled` alone
     * because `onEnabled` fires once, ever, for the first instance: if WorkManager's
     * own records are lost (a "clear data", a restore onto a new device) there would
     * otherwise be no second chance to reschedule.
     * `ExistingPeriodicWorkPolicy.KEEP` makes the repeat a no-op when the job is
     * already there.
     */
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        TrendsRefreshScheduler.ensureScheduled(context)
    }

    /**
     * Last widget of THIS variant removed.
     *
     * The refresh is only cancelled when no variant is left anywhere, which is the
     * whole reason this override is not the one-liner it looks like it should be:
     * `onDisabled` fires per provider, so a user who removes the chip cloud and
     * keeps the list would otherwise have silently stopped the list's refresh — a
     * widget frozen on the trends it happened to hold, with nothing to indicate why.
     */
    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        if (!TrendsWidgets.anyPlaced(context)) {
            TrendsRefreshScheduler.cancel(context)
        }
    }
}
