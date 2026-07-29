package earth.mention.widgets.posts

import android.appwidget.AppWidgetManager
import android.content.Context
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver

/**
 * The trending-posts widget's manifest entry point, and the only place its tick is started
 * or stopped.
 *
 * Tying the WorkManager job to these callbacks is what keeps the widget from costing
 * anything until someone uses one: nothing is scheduled before the first is placed, and
 * nothing survives the last one being removed.
 *
 * There is a single provider here, unlike the trends family's three, so `onDisabled` needs
 * no cross-provider check — it fires exactly when the last posts widget is gone.
 */
class PostsWidgetReceiver : GlanceAppWidgetReceiver() {

    override val glanceAppWidget: GlanceAppWidget = PostsWidget()

    /** First widget placed: start the tick and fill it immediately. */
    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        PostsRefreshScheduler.ensureScheduled(context)
        PostsRefreshScheduler.refreshNow(context)
    }

    /**
     * The system asking for a redraw — after a reboot, an app update, or a locale change.
     *
     * `ensureScheduled` is repeated here rather than left to `onEnabled` alone because
     * `onEnabled` fires once, ever, for the first instance: if WorkManager's own records are
     * lost (a "clear data", a restore onto a new device) there would otherwise be no second
     * chance to reschedule, and the widget would sit on one post forever.
     * `ExistingPeriodicWorkPolicy.KEEP` makes the repeat a no-op when the job is already
     * there.
     */
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        PostsRefreshScheduler.ensureScheduled(context)
    }

    /** Last one removed. */
    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        PostsRefreshScheduler.cancel(context)
    }
}
