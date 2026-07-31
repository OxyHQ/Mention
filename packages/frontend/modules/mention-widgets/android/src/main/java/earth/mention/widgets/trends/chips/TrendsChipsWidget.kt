package earth.mention.widgets.trends.chips

import androidx.compose.runtime.Composable
<<<<<<< HEAD
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.SizeMode
=======
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
import earth.mention.widgets.trends.TrendsWidget
import earth.mention.widgets.trends.WidgetTrend

/**
<<<<<<< HEAD
 * The sizes variant C is designed for.
 *
 * Same launcher-cell grid as the other variants (`70 × n − 30`: 110dp is 2 cells,
 * 180dp is 3, 250dp is 4, 320dp is 5), and the same five, because a chip cloud's row
 * count moves on exactly the same axis a list's does:
 *
 *   110 × 110  (2×2)  no title bar  — 1 row of chips
 *   250 × 110  (4×2)  no title bar  — 1 row  (a wider row holds more)
 *   250 × 180  (4×3)  title bar     — 2 rows  (the default placement)
 *   250 × 250  (4×4)  title bar     — 3 rows
 *   320 × 320  (5×5)  title bar     — 4 rows  (the resize ceiling)
 *
 * The counts are `rowsThatFit` over the chip height, not a table. How many chips land
 * on each of those rows is not fixed at all — it depends on the names, which is the
 * whole point of the variant.
 *
 * Declaring a size that changes nothing would still cost a chart bitmap in the one
 * `RemoteViews` the launcher receives, so the set stops where the row count stops
 * changing.
 */
private val TRENDS_CHIPS_WIDGET_SIZES = setOf(
    DpSize(110.dp, 110.dp),
    DpSize(250.dp, 110.dp),
    DpSize(250.dp, 180.dp),
    DpSize(250.dp, 250.dp),
    DpSize(320.dp, 320.dp),
)

/** Variant C: Mention's trends as a cloud of pills. See [TrendsChipsWidgetContent]. */
internal class TrendsChipsWidget : TrendsWidget() {

    override val sizeMode: SizeMode = SizeMode.Responsive(TRENDS_CHIPS_WIDGET_SIZES)

=======
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

>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
    @Composable
    override fun Content(trends: List<WidgetTrend>) = TrendsChipsWidgetContent(trends)
}
