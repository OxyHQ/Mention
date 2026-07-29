package earth.mention.widgets.trends.card

import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.SizeMode
import earth.mention.widgets.trends.TrendsWidget
import earth.mention.widgets.trends.WidgetTrend

/**
 * The sizes variant J is designed for — FOUR, one fewer than the other two.
 *
 * Same launcher-cell grid (`70 × n − 30`). The card has fewer states than a list or a
 * cloud, because it always shows one headline and its only variable is whether the
 * secondary line comes in:
 *
 *   110 × 110  (2×2)  compact headline, no secondary line
 *   250 × 110  (4×2)  full headline, no secondary line  (the default placement)
 *   250 × 180  (4×3)  headline plus the secondary line
 *   320 × 320  (5×5)  the same, with more of the line filled  (the resize ceiling)
 *
 * 250 × 250 is deliberately absent: between 180dp and 320dp nothing about the card
 * changes except how far apart its two blocks sit, and the layout already absorbs
 * that — the headline is anchored to the top, the secondary line to the bottom, and
 * the space between them is a weighted spacer. A fifth breakpoint would put another
 * chart bitmap into the same `RemoteViews` to render the identical thing.
 */
private val TRENDS_CARD_WIDGET_SIZES = setOf(
    DpSize(110.dp, 110.dp),
    DpSize(250.dp, 110.dp),
    DpSize(250.dp, 180.dp),
    DpSize(320.dp, 320.dp),
)

/** Variant J: the top trend as a tonal card. See [TrendsCardWidgetContent]. */
internal class TrendsCardWidget : TrendsWidget() {

    override val sizeMode: SizeMode = SizeMode.Responsive(TRENDS_CARD_WIDGET_SIZES)

    @Composable
    override fun Content(trends: List<WidgetTrend>) = TrendsCardWidgetContent(trends)
}
