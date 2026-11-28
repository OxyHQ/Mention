package earth.mention.widgets.trends.chips

import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.components.Scaffold
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.RowScope
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
import earth.mention.widgets.trends.estimateTextWidthDp
import earth.mention.widgets.trends.formatCompactCount
import earth.mention.widgets.trends.leadingSeries
import earth.mention.widgets.trends.openInAppIntent
import earth.mention.widgets.trends.packRows
import earth.mention.widgets.trends.rowsThatFit
import earth.mention.widgets.trends.trendDisplayName
import earth.mention.widgets.trends.trendLabel
import earth.mention.widgets.trends.trendUrl

/**
 * Variant C — the CHIP CLOUD: trends as tonal pills that reflow, over the leading
 * trend's chart.
 *
 * The point of the shape is that no size looks half-empty. A list has a fixed row
 * height and a fixed row count, so a widget one cell taller than a breakpoint shows
 * a band of nothing; chips pack, so the same space just takes another chip. Two
 * things make that true here:
 *
 *  1. [packRows] fills each row with as many chips as fit before starting the next.
 *  2. Every chip in a row carries `defaultWeight()`, so a row that ended up with two
 *     chips gives each of them half the width rather than leaving the remainder
 *     blank. Variation in chip width therefore shows up BETWEEN rows — a row of one
 *     wide pill above a row of three narrow ones — which is what makes it read as a
 *     cloud rather than a table.
 *
 * That second point is also what makes the width estimate safe: it decides how many
 * chips a row can hold legibly, and the row fills either way. See
 * `TrendsTextFlow.kt` for why the width can only be estimated at all.
 */

internal object TrendsChipDimensions {
    /**
     * A chip is one tap target, so it is Material's 48dp minimum — the same floor
     * the list variant's rows use. At Material 3 Expressive's larger scale a 48dp
     * pill is a deliberate size rather than an oversized 32dp chip.
     */
    val CHIP_HEIGHT = 48.dp

    /** Half the height: the fully rounded pill of an M3 chip. */
    val CHIP_CORNER_RADIUS = 24.dp

    /**
     * Inside a pill, horizontal padding is measured from the curve rather than from
     * a straight edge, so M3's 16dp for a rectangular container is slightly too
     * tight; 14dp each side is what leaves the text clear of the arc at this radius.
     */
    val CHIP_HORIZONTAL_PADDING = 14.dp

    /**
     * Gap between chips, in both axes. `ActionListLayoutDimensions.verticalSpacing`
     * is 4dp for stacked rows; pills need a touch more so two adjacent ones read as
     * two rather than as one divided shape.
     */
    val CHIP_SPACING = 6.dp

    /**
     * The font sizes the width estimate assumes, which MUST be the ones the chip
     * actually draws with — they are declared here, next to the estimate that
     * consumes them, precisely so the two cannot drift.
     *
     * They correspond to `TrendsWidgetTextStyles.name(compact = true)` (M3 Title
     * Small) and `TrendsWidgetTextStyles.supporting()` (M3 Label Medium).
     */
    const val NAME_FONT_SP = 14f
    const val COUNT_FONT_SP = 12f
}

/** A chip's two pieces of text: the trend, and its post count where it has one. */
private data class ChipContent(val trend: WidgetTrend, val name: String, val count: String)

@Composable
internal fun TrendsChipsWidgetContent(trends: List<WidgetTrend>) {
    val context = LocalContext.current
    val size = LocalSize.current
    val showTitleBar = size.height >= TrendsWidgetDimensions.TITLE_BAR_MIN_HEIGHT
    val compact = size.width < TrendsWidgetDimensions.COMPACT_MAX_WIDTH

    Scaffold(
        backgroundColor = GlanceTheme.colors.widgetBackground,
        modifier = if (showTitleBar) {
            GlanceModifier
        } else {
            GlanceModifier.padding(top = TrendsWidgetDimensions.WIDGET_PADDING)
        },
        // The chart reaches the widget's side edges; the content pads itself. Same
        // arrangement, and the same reason, as the list variant.
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
                if (trends.isEmpty()) {
                    TrendsEmptyContent(textColor = GlanceTheme.colors.onSurface)
                } else {
                    ChipCloud(
                        chips = trends.map { trend ->
                            ChipContent(
                                trend = trend,
                                name = trendDisplayName(trend),
                                count = chipCount(trend),
                            )
                        },
                        // The content's own padding is already subtracted: this is
                        // the width a row of chips actually has to fill.
                        availableWidthDp = size.width.value -
                            TrendsWidgetDimensions.WIDGET_PADDING.value * 2,
                        maxRows = rowsThatFit(
                            widgetHeight = size.height,
                            showTitleBar = showTitleBar,
                            rowHeight = TrendsChipDimensions.CHIP_HEIGHT,
                            rowSpacing = TrendsChipDimensions.CHIP_SPACING,
                        ),
                        fontScale = context.resources.configuration.fontScale,
                    )
                }
            }
        }
    }
}

@Composable
private fun ChipCloud(
    chips: List<ChipContent>,
    availableWidthDp: Float,
    maxRows: Int,
    fontScale: Float,
) {
    val rows = packRows(
        widths = chips.map { estimateChipWidthDp(it.name, it.count, fontScale) },
        availableWidthDp = availableWidthDp,
        maxRows = maxRows,
        spacingDp = TrendsChipDimensions.CHIP_SPACING.value,
    )

    Column(modifier = GlanceModifier.fillMaxSize()) {
        rows.forEachIndexed { rowIndex, indices ->
            Row(modifier = GlanceModifier.fillMaxWidth()) {
                indices.forEachIndexed { positionInRow, chipIndex ->
                    if (positionInRow != 0) {
                        Spacer(GlanceModifier.width(TrendsChipDimensions.CHIP_SPACING))
                    }
                    TrendChip(chip = chips[chipIndex])
                }
            }
            if (rowIndex != rows.lastIndex) {
                Spacer(GlanceModifier.height(TrendsChipDimensions.CHIP_SPACING))
            }
        }
    }
}

/**
 * One pill.
 *
 * `defaultWeight()` is what fills the row — see this file's header. It also means a
 * chip is never narrower than its share of the row, so the name has room to
 * ellipsize gracefully rather than being clipped mid-glyph. It is also why this is a
 * [RowScope] extension: the weight belongs to the row that holds the chip, so it is
 * only reachable in that scope.
 */
@Composable
private fun RowScope.TrendChip(chip: ChipContent) {
    val context = LocalContext.current
    val description = context.getString(
        R.string.mention_trends_widget_item_description,
        chip.name,
        trendLabel(context, chip.trend),
    )

    Row(
        modifier = GlanceModifier
            .height(TrendsChipDimensions.CHIP_HEIGHT)
            .defaultWeight()
            .cornerRadius(TrendsChipDimensions.CHIP_CORNER_RADIUS)
            .background(GlanceTheme.colors.secondaryContainer)
            .padding(horizontal = TrendsChipDimensions.CHIP_HORIZONTAL_PADDING)
            .semantics { contentDescription = description }
            .clickable(
                actionStartActivity(openInAppIntent(context, trendUrl(context, chip.trend))),
            ),
        verticalAlignment = Alignment.Vertical.CenterVertically,
        horizontalAlignment = Alignment.Horizontal.CenterHorizontally,
    ) {
        Text(
            text = chip.name,
            style = TrendsWidgetTextStyles.name(
                color = GlanceTheme.colors.onSecondaryContainer,
                compact = true,
            ),
            maxLines = 1,
            // The chip's own description already reads the trend out.
            modifier = GlanceModifier.semantics { contentDescription = "" },
        )
        if (chip.count.isNotEmpty()) {
            Spacer(GlanceModifier.width(TrendsWidgetDimensions.ITEM_CONTENT_SPACING))
            Text(
                text = chip.count,
                style = TrendsWidgetTextStyles.supporting(GlanceTheme.colors.onSecondaryContainer),
                maxLines = 1,
                modifier = GlanceModifier.semantics { contentDescription = "" },
            )
        }
    }
}

/**
 * The count a chip shows, or an empty string where the trend has none.
 *
 * Same rule as the list variant's rows: only hashtags carry a post count, because
 * only for a hashtag is `volume` a count of posts the reader can go and find.
 */
private fun chipCount(trend: WidgetTrend): String =
    if (trend.kind == TrendKind.HASHTAG && trend.volume > 0) formatCompactCount(trend.volume) else ""

/**
 * How wide a chip needs to be to hold its text without truncating: the pill's
 * padding, the name, and the count with its gap where there is one.
 *
 * [count] empty means the trend has none, and the chip is that much narrower — which
 * is where a lot of the cloud's variety comes from, since only hashtags carry counts.
 */
internal fun estimateChipWidthDp(name: String, count: String, fontScale: Float): Float {
    val padding = TrendsChipDimensions.CHIP_HORIZONTAL_PADDING.value * 2
    val nameWidth = estimateTextWidthDp(name, TrendsChipDimensions.NAME_FONT_SP, fontScale)
    if (count.isEmpty()) return padding + nameWidth
    return padding + nameWidth + TrendsWidgetDimensions.ITEM_CONTENT_SPACING.value +
        estimateTextWidthDp(count, TrendsChipDimensions.COUNT_FONT_SP, fontScale)
}
