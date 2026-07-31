package earth.mention.widgets.trends

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
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
 * The three variants differ only in [Content]; everything else — the size mode, the
 * store subscription, the theme, the absence of per-instance state — is settled once
 * here rather than three times.
 */
internal abstract class TrendsWidget : GlanceAppWidget() {

    /**
     * EXACT, for all three variants, and this is the single most consequential line in
     * the trends widgets — it is what makes each one lay out for the height it actually
     * has.
     *
     * `SizeMode.Responsive(sizes)` was the obvious choice and it was the wrong one. It
     * composes the content once PER DECLARED SIZE and `LocalSize` reports the declared
     * size that matched, never the real one (verified against the artifact: Glance
     * 1.1.1's `SizeBoxKt.ForEachSize` returns `sizeMode.sizes` on API 31+ and
     * `SizeBox` provides `LocalSize` from that). Since every count these widgets
     * compute — `rowsThatFit`, `packRows`, which form the card draws — is derived from
     * `LocalSize`, they were all quantised to the declared set. A ranked list 170dp
     * tall matched the 110dp declaration and drew ONE row where two fit; a 220dp one
     * drew two where three fit. That is not a rounding error, it is a whole 48dp touch
     * target of content withheld from a widget that had room for it, and it is exactly
     * what a user notices.
     *
     * With `Exact`, Glance composes for the sizes the HOST reports —
     * `AppWidgetManager.OPTION_APPWIDGET_SIZES` on API 31+, the real portrait and
     * landscape dimensions below it — so `LocalSize` is the widget's own size and every
     * derived count is the true one at every height. Nothing is quantised and no
     * breakpoint has to be declared for a height to be laid out well.
     *
     * The three costs, and why each is acceptable here:
     *
     *  - A SIZE CHANGE NEEDS A RECOMPOSITION, where `Responsive` lets the launcher
     *    switch between pre-composed variants with no work from us. It is cheap in this
     *    module and only in this module: the content comes from a local DataStore
     *    ([TrendsRepository]) and never from the network, so the recomposition is a
     *    read and a re-translate. `GlanceAppWidgetReceiver.onAppWidgetOptionsChanged`
     *    is what delivers the new size, and no receiver here overrides it.
     *  - THE VARIANT COUNT IS THE HOST'S, not ours. That is the real trade: a launcher
     *    reporting an unusual number of sizes changes the payload, where a declared set
     *    is fixed. AOSP reports two (portrait and landscape); `TrendsBreakpointsTest`
     *    bounds the per-variant chart bitmap so the safe count is stated rather than
     *    assumed.
     *  - LESS UNIFORM ACROSS LAUNCHERS than the declared path.
     *
     * It also makes the payload smaller rather than larger, which is the opposite of
     * what more breakpoints would have done: two composed variants sized to the real
     * placement instead of five sized to the declarations.
     */
    final override val sizeMode: SizeMode = SizeMode.Exact

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
