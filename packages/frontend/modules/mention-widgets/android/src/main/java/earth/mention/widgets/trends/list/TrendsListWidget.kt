package earth.mention.widgets.trends.list

import androidx.compose.runtime.Composable
import androidx.glance.appwidget.SizeMode
import earth.mention.widgets.trends.TrendsWidget
import earth.mention.widgets.trends.WidgetTrend

/** Variant A: Mention's trends as a ranked list. See [TrendsListWidgetContent]. */
internal class TrendsListWidget : TrendsWidget() {

    /**
     * [SizeMode.Exact], not `Responsive`, because the row count IS the layout.
     *
     * ## What Responsive was doing wrong
     *
     * It declared five sizes — 110×110, 250×110, 250×180, 250×250, 320×320 — and Glance
     * hands the composition the largest DECLARED size that fits, not the real one. So a
     * placement 230dp tall got the 180dp rendering: `rowsThatFit` was asked about 180dp,
     * answered two rows, and 50dp of the widget sat empty below them. Observed on a real
     * launcher — the list showed two trends with visible room for a third, which is the
     * complaint this fixes.
     *
     * Every height between two declared sizes wasted the difference, and no set of
     * buckets removes that: quantising is what `Responsive` is. Adding buckets only makes
     * the wasted band narrower while making the payload worse, since each declared size is
     * composed into the SAME `RemoteViews` with its own chart bitmap.
     *
     * ## Why Exact is the right trade here rather than a cheat
     *
     * `Exact` gives the composition the actual size, so `rowsThatFit` is asked the real
     * question and the list fills the space it was given. The cost is a recomposition per
     * size change instead of one parcel covering every size — and for this widget that
     * cost is NEGATIVE: the parcel now carries one layout and one sparkline bitmap rather
     * than five of each, which is the payload pressure that made `Responsive` attractive
     * for the trending-POSTS widget in the first place. That widget keeps `Responsive`,
     * where the reasoning still holds: its designs differ in what they show, not only in
     * how many rows fit, and it carries a post image as well as an avatar.
     *
     * The breakpoint behaviour is not lost — it lives in `TrendsListLayout`, which already
     * decides from the measured height whether to show a title bar and whether to become a
     * single headline. It now decides that from the height the widget really has.
     */
    override val sizeMode: SizeMode = SizeMode.Exact

    @Composable
    override fun Content(trends: List<WidgetTrend>) = TrendsListWidgetContent(trends)
}
