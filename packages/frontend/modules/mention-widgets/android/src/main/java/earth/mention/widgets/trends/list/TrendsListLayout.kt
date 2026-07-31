package earth.mention.widgets.trends.list

import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.Dp
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
import earth.mention.widgets.trends.TrendsWidgetFontSizes
import earth.mention.widgets.trends.TrendsWidgetTextStyles
import earth.mention.widgets.trends.WidgetTrend
import earth.mention.widgets.trends.estimateLineHeightDp
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
 *
 * ONE CELL OF HEIGHT goes one step further ([LIST_SHORT_MAX_HEIGHT]). The lead above
 * still has the room for a full 26sp headline, its supporting line and a chart behind
 * them; at 60dp it has room for the trend and its volume and nothing whatever else, so
 * that is what it draws — see [TrendsListShortLead]. That form, not a one-row list, is
 * what the list turns into at its resize floor.
 *
 * Every one of those counts comes from the height the widget REALLY has, because the
 * size mode is `SizeMode.Exact` (see `TrendsWidget`). Under the declared-size set this
 * variant used to carry, a 170dp list was composed as the 110dp declaration and drew one
 * row while two fit.
 */

/**
 * Below this height the list draws [TrendsListShortLead] instead of anything else.
 *
 * Two launcher cells (`70 × 2 − 30`). At or above it the widget can hold the lead's full
 * 26sp headline, its supporting line and the chart band behind them; below it — which is
 * to say at one cell, the resize floor — it cannot hold any two of the three.
 */
private val LIST_SHORT_MAX_HEIGHT = 110.dp

/**
 * Padding around the short form, on all four sides.
 *
 * 8dp rather than the 12dp every other surface in this module uses, because at 60dp of
 * height 12dp twice over is a fifth of the widget. It is the same value, chosen the same
 * way, as the card's short form.
 */
private val LIST_SHORT_PADDING = 8.dp

/**
 * Whether the short form has room for the trend's volume as well as its name.
 *
 * The same rule as the card's, against the same shared line-height estimate and for the
 * same reason: at the 60dp floor the two lines occupy 41.6dp of a 44dp content box, so one
 * step up the reader's font scale pushes the second past the bottom edge, where a
 * `RemoteViews` clips it rather than shrinking it. Dropping it keeps the name whole, and
 * the volume is still announced — it is part of the lead's content description.
 *
 * The two variants keep their own copy of the rule rather than sharing one function
 * because each measures against its OWN padding; what they share is
 * [estimateLineHeightDp] and the type scale it reads.
 */
internal fun listShortLeadShowsSupportingLine(widgetHeight: Dp, fontScale: Float): Boolean {
    val available = widgetHeight.value - LIST_SHORT_PADDING.value * 2
    val text = estimateLineHeightDp(TrendsWidgetFontSizes.HEADLINE_COMPACT, fontScale) +
        estimateLineHeightDp(TrendsWidgetFontSizes.SUPPORTING, fontScale)
    return text <= available
}

@Composable
internal fun TrendsListWidgetContent(trends: List<WidgetTrend>) {
    val context = LocalContext.current
    val size = LocalSize.current
    val short = size.height < LIST_SHORT_MAX_HEIGHT
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
        // arrangement as the canonical ActionListLayout. The short form pads itself
        // tighter still, and on both sides, since 12dp twice over is a fifth of it.
        modifier = when {
            showTitleBar -> GlanceModifier
            short -> GlanceModifier.padding(top = LIST_SHORT_PADDING)
            else -> GlanceModifier.padding(top = TrendsWidgetDimensions.WIDGET_PADDING)
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
            // NO CHART at one cell of height, for the reason the card's short form
            // draws none either: the band has a 40dp floor, so at 60dp it covers two
            // thirds of the widget and the one line that matters would be drawn
            // straight across the stroke. The chart is this variant's background, not
            // its content.
            if (!short) {
                SparklineBackground(leadingSeries(trends), GlanceTheme.colors.primary)
            }
            Box(
                GlanceModifier
                    .fillMaxSize()
                    // No `horizontal`-plus-`bottom` overload in Glance, hence the
                    // four-sided form with no top: the title bar or the Scaffold
                    // modifier above has already provided that side.
                    .padding(
                        start = if (short) LIST_SHORT_PADDING else TrendsWidgetDimensions.WIDGET_PADDING,
                        end = if (short) LIST_SHORT_PADDING else TrendsWidgetDimensions.WIDGET_PADDING,
                        bottom = if (short) LIST_SHORT_PADDING else TrendsWidgetDimensions.WIDGET_PADDING,
                    ),
            ) {
                when {
                    trends.isEmpty() -> TrendsEmptyContent(textColor = GlanceTheme.colors.onSurface)
                    short -> TrendsListShortLead(
                        trend = trends.first(),
                        showSupportingLine = listShortLeadShowsSupportingLine(
                            widgetHeight = size.height,
                            fontScale = context.resources.configuration.fontScale,
                        ),
                    )
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
 * ONE CELL OF HEIGHT: the top trend and its volume, centred, and nothing else.
 *
 * What it gives up against [TrendsListLead], and what drove each:
 *
 *  - THE RANK NUMERAL. There is no rank to show. A numeral indexes a trend against the
 *    ones below it, and here there are none — `TrendRow` already drops it at a compact
 *    width for the weaker version of the same reason. It would also eat 20dp of the
 *    width the name needs.
 *  - THE CHART. See the note at the call site: a 40dp band inside a 60dp widget is a
 *    backdrop under the text rather than a band behind it.
 *  - THE FULL-SIZE HEADLINE. The compact 20sp step, chosen here by the HEIGHT rather
 *    than by the width, because 26sp plus a supporting line needs 49dp of the 44dp this
 *    form has.
 *  - THE SUPPORTING LINE, but only when the reader's font setting leaves no room for it
 *    ([listShortLeadShowsSupportingLine]).
 *
 * Centred rather than top-aligned, unlike the lead: the chart it would otherwise keep
 * clear of is not drawn here, and centring makes the whole widget one tap target instead
 * of the 42dp the two lines occupy — Material's minimum is 48dp.
 */
@Composable
private fun TrendsListShortLead(trend: WidgetTrend, showSupportingLine: Boolean) {
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
        verticalAlignment = Alignment.Vertical.CenterVertically,
    ) {
        Text(
            text = name,
            style = TrendsWidgetTextStyles.headline(GlanceTheme.colors.onSurface, compact = true),
            maxLines = 1,
            modifier = GlanceModifier.semantics { contentDescription = "" },
        )
        if (showSupportingLine) {
            Text(
                text = label,
                style = TrendsWidgetTextStyles.supporting(GlanceTheme.colors.onSurfaceVariant),
                maxLines = 1,
                modifier = GlanceModifier.semantics { contentDescription = "" },
            )
        }
    }
}

/**
 * What a widget too short for two rows draws instead of a list: the leading trend, as a
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
