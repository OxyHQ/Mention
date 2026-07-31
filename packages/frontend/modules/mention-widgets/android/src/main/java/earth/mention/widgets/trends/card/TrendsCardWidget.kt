package earth.mention.widgets.trends.card

import androidx.compose.runtime.Composable
import earth.mention.widgets.trends.TrendsWidget
import earth.mention.widgets.trends.WidgetTrend

/**
 * Variant J: the top trend as a tonal card. See [TrendsCardWidgetContent].
 *
 * It declares no size set, and neither do the other two: the size mode is
 * `SizeMode.Exact`, settled once in [TrendsWidget], so the card is composed for the
 * height it actually has rather than for the nearest of a handful of declarations. What
 * it shows at a given height is therefore a property of the layout —
 * [TrendsCardDensity] — instead of a table of breakpoints that has to be kept in step
 * with one.
 *
 * The card is still the only variant a launcher will let the user drag below two cells
 * of height; that floor is `mention_trends_card_widget_min_resize_height`, not a
 * declared size.
 */
internal class TrendsCardWidget : TrendsWidget() {

    @Composable
    override fun Content(trends: List<WidgetTrend>) = TrendsCardWidgetContent(trends)
}
