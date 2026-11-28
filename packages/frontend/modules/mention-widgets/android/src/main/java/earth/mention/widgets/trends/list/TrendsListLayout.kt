package earth.mention.widgets.trends.list

import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.components.Scaffold
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.Text
import earth.mention.widgets.R
import earth.mention.widgets.sparkline.SparklineBackground
import earth.mention.widgets.trends.TrendKind
import earth.mention.widgets.trends.TrendsEmptyContent
import earth.mention.widgets.trends.TrendsTitleBar
import earth.mention.widgets.trends.TrendsWidgetDimensions
import earth.mention.widgets.trends.TrendsWidgetTextStyles
import earth.mention.widgets.trends.WidgetTrend
import earth.mention.widgets.trends.formatCompactCount
import earth.mention.widgets.trends.leadingSeries
import earth.mention.widgets.trends.openInAppIntent
import earth.mention.widgets.trends.rowsThatFit
import earth.mention.widgets.trends.trendDisplayName
import earth.mention.widgets.trends.trendLabel
import earth.mention.widgets.trends.trendUrl

/**
 * Variant A — the RANKED LIST: Google's canonical text-list layout, a `Scaffold`
 * under a `TitleBar` holding a vertical index of tappable rows, over the leading
 * trend's chart.
 *
 * Why the text list and not the text-AND-image one: a trend has no image. There is
 * no avatar, no thumbnail and no per-trend artwork anywhere in the product, so the
 * image variant would need a placeholder in every leading slot, and a column of
 * identical placeholders is worse than no column. The leading slot carries the rank
 * numeral the app's own trends list already shows.
 *
 * Rows are UNFILLED — the canonical `ActionListLayout` ships both a filled and an
 * unfilled item and this layout takes the unfilled one, because a row with an
 * opaque tonal background would hide the chart behind it and the chart is the point
 * of this design. The whole row stays one 48dp tap target either way.
 *
 * WHAT THE SMALL SIZES DO. Below two rows the list stops being a list: it draws the
 * single leading trend as a headline instead (see [TrendsListLead]). That is the
 * one behaviour this variant exists to get right — a 2×2 widget has room for one
 * 48dp row and nothing else, so a list there is a list of one, which reads as a
 * list that failed to load rather than as a deliberate smaller widget. Showing
 * LESS, in a shape that suits the space, is the honest answer to being resized
 * down. The threshold is not configured: it is [rowsThatFit] reaching one.
 */
@Composable
internal fun TrendsListWidgetContent(trends: List<WidgetTrend>) {
    val size = LocalSize.current
    val showTitleBar = size.height >= TrendsWidgetDimensions.TITLE_BAR_MIN_HEIGHT
    val compact = size.width < TrendsWidgetDimensions.COMPACT_MAX_WIDTH
    val rows = rowsThatFit(
        widgetHeight = size.height,
        showTitleBar = showTitleBar,
        rowHeight = TrendsWidgetDimensions.ROW_HEIGHT,
        rowSpacing = TrendsWidgetDimensions.ITEM_SPACING,
    )

    Scaffold(
        backgroundColor = GlanceTheme.colors.widgetBackground,
        // Without a title bar there is nothing above the content, so the padding
        // the title bar would have provided has to come from somewhere. Same
        // arrangement as the canonical ActionListLayout.
        modifier = if (showTitleBar) {
            GlanceModifier
        } else {
            GlanceModifier.padding(top = TrendsWidgetDimensions.WIDGET_PADDING)
        },
        // Scaffold's own 12dp would inset the chart too. The chart has to reach the
        // widget's side edges to read as a background rather than as a cropped
        // card, so the padding moves inside, onto the content.
        horizontalPadding = 0.dp,
        titleBar = if (showTitleBar) {
            { TrendsTitleBar(compact = compact) }
        } else {
            null
        },
    ) {
        Box(GlanceModifier.fillMaxSize()) {
            SparklineBackground(leadingSeries(trends), GlanceTheme.colors.primary)
            Box(
                GlanceModifier
                    .fillMaxSize()
                    // No `horizontal`-plus-`bottom` overload in Glance, hence the
                    // four-sided form with no top: the title bar or the Scaffold
                    // modifier above has already provided that side.
                    .padding(
                        start = TrendsWidgetDimensions.WIDGET_PADDING,
                        end = TrendsWidgetDimensions.WIDGET_PADDING,
                        bottom = TrendsWidgetDimensions.WIDGET_PADDING,
                    ),
            ) {
                when {
                    trends.isEmpty() -> TrendsEmptyContent(textColor = GlanceTheme.colors.onSurface)
                    rows <= 1 -> TrendsListLead(trend = trends.first(), compact = compact)
                    else -> TrendsList(trends = trends, maxRows = rows, compact = compact)
                }
            }
        }
    }
}

/**
 * The list.
 *
 * A plain [Column] of exactly the rows that fit, not a scrolling lazy list: at two
 * to four items there is nothing to scroll, and a `LazyColumn` would put a
 * RemoteViews collection between the launcher and four rows of text. The breakpoint
 * decides what is shown; the user resizes to see more.
 */
@Composable
private fun TrendsList(trends: List<WidgetTrend>, maxRows: Int, compact: Boolean) {
    val visible = trends.take(maxRows)
    Column(modifier = GlanceModifier.fillMaxSize()) {
        visible.forEachIndexed { index, trend ->
            TrendRow(trend = trend, ordinal = index + 1, compact = compact)
            if (index != visible.lastIndex) {
                Spacer(GlanceModifier.height(TrendsWidgetDimensions.ITEM_SPACING))
            }
        }
    }
}

/**
 * One trend.
 *
 * A single line, not the two-line row the app's list uses: the whole row is one
 * 48dp touch target, and two lines of type inside 48dp leaves no vertical padding
 * at all. The type of trend is still carried — hashtags keep their `#` and their
 * post count — and the full "Trending topic" / "Trending · N posts" wording lives
 * in the row's content description, so a screen reader hears exactly what the app's
 * list shows.
 */
@Composable
private fun TrendRow(trend: WidgetTrend, ordinal: Int, compact: Boolean) {
    val context = LocalContext.current
    val name = trendDisplayName(trend)
    val rowDescription = context.getString(
        R.string.mention_trends_widget_item_description,
        name,
        trendLabel(context, trend),
    )

    Row(
        modifier = GlanceModifier
            .fillMaxWidth()
            .height(TrendsWidgetDimensions.ROW_HEIGHT)
            .semantics { contentDescription = rowDescription }
            .clickable(actionStartActivity(openInAppIntent(context, trendUrl(context, trend)))),
        verticalAlignment = Alignment.Vertical.CenterVertically,
    ) {
        if (!compact) {
            Text(
                text = ordinal.toString(),
                style = TrendsWidgetTextStyles.supporting(GlanceTheme.colors.onSurfaceVariant),
                maxLines = 1,
                modifier = GlanceModifier
                    .width(TrendsWidgetDimensions.ORDINAL_WIDTH)
                    // The row's own description already reads the trend out; without
                    // this the numeral would be announced a second time on its own.
                    .semantics { contentDescription = "" },
            )
        }
        Text(
            text = name,
            style = TrendsWidgetTextStyles.name(GlanceTheme.colors.onSurface, compact),
            maxLines = 1,
            modifier = GlanceModifier.defaultWeight().semantics { contentDescription = "" },
        )
        if (trend.kind == TrendKind.HASHTAG && trend.volume > 0) {
            Spacer(GlanceModifier.width(TrendsWidgetDimensions.ITEM_CONTENT_SPACING))
            Text(
                text = formatCompactCount(trend.volume),
                style = TrendsWidgetTextStyles.supporting(GlanceTheme.colors.onSurfaceVariant),
                maxLines = 1,
                modifier = GlanceModifier.semantics { contentDescription = "" },
            )
        }
    }
}

/**
 * What the two shortest breakpoints draw instead of a list: the leading trend, as a
 * headline with its supporting line.
 *
 * Top-aligned rather than centred, and that is the chart's doing — the chart is a
 * band along the bottom edge, so text pinned to the top of the content area is the
 * arrangement where the two do not overlap at the sizes where there is least room
 * for them to.
 */
@Composable
private fun TrendsListLead(trend: WidgetTrend, compact: Boolean) {
    val context = LocalContext.current
    val name = trendDisplayName(trend)
    val label = trendLabel(context, trend)

    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .semantics {
                contentDescription = context.getString(
                    R.string.mention_trends_widget_item_description,
                    name,
                    label,
                )
            }
            .clickable(actionStartActivity(openInAppIntent(context, trendUrl(context, trend)))),
        verticalAlignment = Alignment.Vertical.Top,
    ) {
        Text(
            text = name,
            style = TrendsWidgetTextStyles.headline(GlanceTheme.colors.onSurface, compact),
            maxLines = 1,
            modifier = GlanceModifier.semantics { contentDescription = "" },
        )
        Text(
            text = label,
            style = TrendsWidgetTextStyles.supporting(GlanceTheme.colors.onSurfaceVariant),
            maxLines = 1,
            modifier = GlanceModifier.semantics { contentDescription = "" },
        )
    }
}
