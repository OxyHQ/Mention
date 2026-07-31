package earth.mention.widgets

import earth.mention.widgets.trends.TrendsRefreshScheduler
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS side of Mention's home-screen widgets.
 *
 * Deliberately tiny, and it will stay that way. A widget has to work while the
 * app is not running, so every widget owns its own data end to end in Kotlin —
 * fetch, store, render, deep link. Anything JS also did would be a second copy
 * of that path, correct only for as long as both stayed in step.
 *
 * What is left for JS is CONTROL, not data: the app is the one thing that can
 * know a trending batch rotated while the user was looking at it, and telling
 * the widget so turns a wait of up to half an hour into a few seconds. The
 * decision of WHEN that is worth doing is in `trendsWidgetSync.ts`.
 */
class MentionWidgetsModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("MentionWidgets")

        /**
         * Fetch the trending batch now, for whichever trends widgets are placed.
         *
         * Returns as soon as the work is enqueued; the fetch itself runs in
         * WorkManager under the same network constraint as the periodic refresh,
         * and is a no-op when no trends widget of any variant is on the home
         * screen. One fetch serves all three — they read the same store.
         */
        AsyncFunction("refreshTrends") {
            val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
            TrendsRefreshScheduler.refreshNow(context)
        }
    }
}
