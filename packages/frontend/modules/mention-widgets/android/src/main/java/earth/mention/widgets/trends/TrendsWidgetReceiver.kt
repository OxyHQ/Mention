package earth.mention.widgets.trends

import android.appwidget.AppWidgetManager
import android.content.Context
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver

/**
 * The manifest entry point for the trends widget, and the only place its refresh
 * schedule is started or stopped.
 *
 * Tying the WorkManager job to these callbacks is what keeps the widget from
 * costing anything until someone uses it: nothing is scheduled before the first
 * one is placed, and nothing survives the last one being removed.
 */
class TrendsWidgetReceiver : GlanceAppWidgetReceiver() {

    override val glanceAppWidget: GlanceAppWidget = TrendsWidget()

    /** First widget placed: start the schedule and fill it immediately. */
    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        TrendsRefreshScheduler.ensureScheduled(context)
        TrendsRefreshScheduler.refreshNow(context)
    }

    /**
     * The system asking for a redraw — after a reboot, an app update, or a
     * locale change.
     *
     * `ensureScheduled` is repeated here rather than left to `onEnabled` alone
     * because `onEnabled` fires once, ever, for the first instance: if
     * WorkManager's own records are lost (a "clear data", a restore onto a new
     * device) there would otherwise be no second chance to reschedule.
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

    /** Last widget removed: stop refreshing. */
    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        TrendsRefreshScheduler.cancel(context)
    }
}
