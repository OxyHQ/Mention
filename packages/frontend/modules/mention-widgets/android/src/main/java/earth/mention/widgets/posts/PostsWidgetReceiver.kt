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

<<<<<<< HEAD
    /** First widget placed: start both ticks and fill it immediately. */
    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        PostsRefreshScheduler.ensureScheduled(context)
        PostsRefreshScheduler.ensureAutoAdvance(context)
        PostsRefreshScheduler.refreshNow(context)
=======
    /** First widget placed: start both ticks and fill the card immediately. */
    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        PostsRefreshScheduler.ensureScheduled(context)
        PostsRefreshScheduler.refreshNow(context)
        PostsRefreshScheduler.ensureRotating(context)
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
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
     *
<<<<<<< HEAD
     * The automatic-turn chain is restarted from here for a second reason: it deliberately
     * stops itself whenever the screen is off, rather than turning a widget nobody can see.
     * This is where it picks back up — `onUpdate` fires when the launcher comes back to a home
     * screen holding the widget — and `ExistingWorkPolicy.KEEP` is what stops a burst of
     * updates from forking the chain or resetting its delay forever.
=======
     * It is ALSO where the rotation chain comes back to life. That chain deliberately ends
     * itself whenever the screen goes off, so something has to restart it; this callback and
     * the refresh tick are the two things that do. `ensureRotating` keeps a chain that is
     * already counting, so a burst of updates cannot hold the rotation at the start of its
     * delay forever.
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
     */
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        PostsRefreshScheduler.ensureScheduled(context)
<<<<<<< HEAD
        PostsRefreshScheduler.ensureAutoAdvance(context)
=======
        PostsRefreshScheduler.ensureRotating(context)
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
    }

    /** Last one removed. */
    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        PostsRefreshScheduler.cancel(context)
    }
}
