package earth.mention.widgets.trends.list

import androidx.compose.runtime.Composable
import earth.mention.widgets.trends.TrendsWidget
import earth.mention.widgets.trends.WidgetTrend

/**
 * Variant A: Mention's trends as a ranked list. See [TrendsListWidgetContent].
 *
 * It declares no size set. The size mode is `SizeMode.Exact`, settled once in
 * [TrendsWidget], and that is what lets the row count be `rowsThatFit` over the height
 * the widget REALLY has: the declared set this variant used to carry is what made a
 * 170dp-tall list draw one row where two fit.
 *
 * Its resize floor is `mention_trends_list_widget_min_resize_height` — one cell of
 * height, where the list stops being a list and leads with the top trend alone.
 */
internal class TrendsListWidget : TrendsWidget() {

    @Composable
    override fun Content(trends: List<WidgetTrend>) = TrendsListWidgetContent(trends)
}
