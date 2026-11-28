package earth.mention.widgets.trends

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.provideContent
import androidx.glance.state.GlanceStateDefinition
import earth.mention.widgets.theme.MentionGlanceTheme
import kotlinx.coroutines.flow.first

/**
 * What all three trends widgets do identically: read the store and draw.
 *
 * The content comes from [TrendsRepository], never from a fetch started here:
 * composing a widget happens while the launcher waits, so the only thing that
 * touches the network is [TrendsRefreshWorker]. That separation is also what makes
 * the widgets survive an outage — they render whatever the store last held, with no
 * notion of whether the fetch behind it succeeded.
 *
 * The three variants differ only in [Content] and in the sizes they declare, so
 * everything else — the store subscription, the theme, the absence of per-instance
 * state — is settled once here rather than three times.
 */
internal abstract class TrendsWidget : GlanceAppWidget() {

    /**
     * No per-widget state. Every instance of every variant shows the same trends
     * and reads them from one app-scoped store, so the default
     * `PreferencesGlanceStateDefinition` would only create an empty preferences
     * file per widget id.
     */
    final override val stateDefinition: GlanceStateDefinition<*>? = null

    /** The variant's own layout. */
    @Composable
    protected abstract fun Content(trends: List<WidgetTrend>)

    final override suspend fun provideGlance(context: Context, id: GlanceId) {
        // Built once, outside the composition: `TrendsRepository.trends` returns a
        // fresh Flow per call, and collecting a new instance on every
        // recomposition would resubscribe to DataStore each time.
        val trends = TrendsRepository.trends(context)
        val initial = trends.first()

        provideContent {
            val current by trends.collectAsState(initial = initial)
            MentionGlanceTheme {
                Content(current)
            }
        }
    }
}
