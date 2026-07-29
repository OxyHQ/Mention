package earth.mention.widgets.trends

import android.content.Context
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.provideContent
import androidx.glance.state.GlanceStateDefinition
import earth.mention.widgets.theme.MentionGlanceTheme
import kotlinx.coroutines.flow.first

/**
 * The sizes the layout is designed for, and therefore the ones the launcher may
 * pick a rendering for.
 *
 * Each is a whole number of launcher cells under the `70 × n − 30` conversion in
 * the App Widget sizing guide, so a size here is a placement the grid can
 * actually produce: 110dp is 2 cells, 180dp is 3, 250dp is 4, 320dp is 5.
 *
 *   110 × 110  (2×2)  no title bar, no rank numeral, 14sp — 1 row
 *   250 × 110  (4×2)  no title bar, rank numeral, 16sp    — 1 row
 *   250 × 180  (4×3)  title bar                            — 2 rows  (the default placement)
 *   250 × 250  (4×4)  title bar                            — 3 rows
 *   320 × 320  (5×5)  title bar                            — 4 rows  (the resize ceiling)
 *
 * The row counts are not configured anywhere: they are what `maxRows` computes
 * from each height. They are listed here so the intent of each breakpoint is
 * readable without running it.
 */
private val TRENDS_WIDGET_SIZES = setOf(
    DpSize(110.dp, 110.dp),
    DpSize(250.dp, 110.dp),
    DpSize(250.dp, 180.dp),
    DpSize(250.dp, 250.dp),
    DpSize(320.dp, 320.dp),
)

/**
 * Mention's trends on the home screen.
 *
 * The content comes from [TrendsRepository], never from a fetch started here:
 * composing a widget happens while the launcher waits, so the only thing that
 * touches the network is [TrendsRefreshWorker]. That separation is also what
 * makes the widget survive an outage — it renders whatever the store last held,
 * with no notion of whether the fetch behind it succeeded.
 */
internal class TrendsWidget : GlanceAppWidget() {

    override val sizeMode: SizeMode = SizeMode.Responsive(TRENDS_WIDGET_SIZES)

    /**
     * No per-widget state. Every instance shows the same trends and reads them
     * from one app-scoped store, so the default `PreferencesGlanceStateDefinition`
     * would only create an empty preferences file per widget id.
     */
    override val stateDefinition: GlanceStateDefinition<*>? = null

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        // Built once, outside the composition: `TrendsRepository.trends` returns a
        // fresh Flow per call, and collecting a new instance on every
        // recomposition would resubscribe to DataStore each time.
        val trends = TrendsRepository.trends(context)
        val initial = trends.first()

        provideContent {
            val current by trends.collectAsState(initial = initial)
            MentionGlanceTheme {
                TrendsWidgetContent(current)
            }
        }
    }
}
