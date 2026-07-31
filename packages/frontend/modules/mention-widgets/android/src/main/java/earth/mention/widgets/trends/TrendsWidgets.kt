package earth.mention.widgets.trends

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import androidx.glance.appwidget.updateAll
import earth.mention.widgets.trends.card.TrendsCardWidget
import earth.mention.widgets.trends.card.TrendsCardWidgetReceiver
import earth.mention.widgets.trends.chips.TrendsChipsWidget
import earth.mention.widgets.trends.chips.TrendsChipsWidgetReceiver
import earth.mention.widgets.trends.list.TrendsListWidget
import earth.mention.widgets.trends.list.TrendsListWidgetReceiver

/**
 * The three trends widgets, as one family.
 *
 * They share a store, a refresh schedule and a worker, so the two questions that
 * span all of them — is ANY of them on a home screen, and redraw ALL of them — are
 * answered once here. Adding a fourth variant means adding it to both lists below
 * and nowhere else.
 */
internal object TrendsWidgets {

    /**
     * The manifest providers. Kept as receiver classes rather than widget classes
     * because placement is a question about a PROVIDER, and `AppWidgetManager`
     * answers it synchronously — which is what [anyPlaced]'s caller in
     * `TrendsWidgetReceiver.onDisabled` needs, since a broadcast callback cannot
     * wait on Glance's suspending manager.
     */
    private val RECEIVERS = listOf(
        TrendsListWidgetReceiver::class.java,
        TrendsChipsWidgetReceiver::class.java,
        TrendsCardWidgetReceiver::class.java,
    )

    /** Whether any trends widget, of any variant, is currently on a home screen. */
    fun anyPlaced(context: Context): Boolean {
        // Null where the device has no app-widget host at all (some TV and
        // automotive builds); nothing is placed there by definition.
        val manager = AppWidgetManager.getInstance(context) ?: return false
        return RECEIVERS.any { receiver ->
            manager.getAppWidgetIds(ComponentName(context, receiver)).isNotEmpty()
        }
    }

    /**
     * Redraw every placed widget of every variant.
     *
     * The store's Flow already re-renders any widget with a live Glance session;
     * this covers the rest, a widget whose session has been torn down and is only
     * redrawn when something asks it to be. `updateAll` on a variant with no
     * instances is a no-op, so no placement check is needed first.
     */
    suspend fun redrawAll(context: Context) {
        TrendsListWidget().updateAll(context)
        TrendsChipsWidget().updateAll(context)
        TrendsCardWidget().updateAll(context)
    }
}
