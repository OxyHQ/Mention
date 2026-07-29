package earth.mention.widgets.trends.list

import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.SizeMode
import earth.mention.widgets.trends.TrendsWidget
import earth.mention.widgets.trends.WidgetTrend

/**
 * The sizes variant A is designed for, and therefore the ones the launcher may pick
 * a rendering for.
 *
 * Each is a whole number of launcher cells under the `70 × n − 30` conversion in the
 * App Widget sizing guide, so a size here is a placement the grid can actually
 * produce: 110dp is 2 cells, 180dp is 3, 250dp is 4, 320dp is 5.
 *
 *   110 × 110  (2×2)  no title bar, headline           — the leading trend only
 *   250 × 110  (4×2)  no title bar, larger headline    — the leading trend only
 *   250 × 180  (4×3)  title bar                        — 2 rows  (the default placement)
 *   250 × 250  (4×4)  title bar                        — 3 rows
 *   320 × 320  (5×5)  title bar                        — 4 rows  (the resize ceiling)
 *
 * None of those counts is configured anywhere: they are what `rowsThatFit` computes
 * from each height, and the two shortest reaching ONE is what turns the list into a
 * headline. They are listed here so the intent of each breakpoint is readable
 * without running it.
 *
 * The set is kept to five because every declared size is composed into the SAME
 * `RemoteViews` the launcher receives, each with its own chart bitmap. Five is the
 * count at which each breakpoint still changes what the widget shows — drop 250×110
 * and a 4×2 placement renders the 2×2 layout stretched across twice the width;
 * drop 320×320 and a 5×5 placement shows three rows in space enough for four.
 */
private val TRENDS_LIST_WIDGET_SIZES = setOf(
    DpSize(110.dp, 110.dp),
    DpSize(250.dp, 110.dp),
    DpSize(250.dp, 180.dp),
    DpSize(250.dp, 250.dp),
    DpSize(320.dp, 320.dp),
)

/** Variant A: Mention's trends as a ranked list. See [TrendsListWidgetContent]. */
internal class TrendsListWidget : TrendsWidget() {

    override val sizeMode: SizeMode = SizeMode.Responsive(TRENDS_LIST_WIDGET_SIZES)

    @Composable
    override fun Content(trends: List<WidgetTrend>) = TrendsListWidgetContent(trends)
}
