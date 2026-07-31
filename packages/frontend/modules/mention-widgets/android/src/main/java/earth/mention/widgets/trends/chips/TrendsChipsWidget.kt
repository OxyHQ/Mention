package earth.mention.widgets.trends.chips

import androidx.compose.runtime.Composable
import earth.mention.widgets.trends.TrendsWidget
import earth.mention.widgets.trends.WidgetTrend

/**
 * Variant C: Mention's trends as a cloud of pills. See [TrendsChipsWidgetContent].
 *
 * It declares no size set. The size mode is `SizeMode.Exact`, settled once in
 * [TrendsWidget], and the cloud gains twice over from it: `rowsThatFit` gets the height
 * the widget really has, so a row of chips is no longer dropped from a cloud with room
 * for it, and `packRows` gets the real width, so how many chips land on each row is
 * measured against the space they actually have.
 *
 * Its resize floor is deliberately still the shared `mention_trends_widget_min_resize_height`
 * — two cells. The card and the list each have a form worth showing in one cell (one big
 * trend, one row); a cloud reduced to a single chip is a weaker thing than either, so
 * this variant keeps the floor at the smallest size it has something to say at.
 */
internal class TrendsChipsWidget : TrendsWidget() {

    @Composable
    override fun Content(trends: List<WidgetTrend>) = TrendsChipsWidgetContent(trends)
}
