package earth.mention.widgets.trends

import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.components.CircleIconButton
import androidx.glance.appwidget.components.FilledButton
import androidx.glance.appwidget.components.Scaffold
import androidx.glance.appwidget.components.TitleBar
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
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
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import earth.mention.widgets.R

/**
 * The trends widget's UI: Google's canonical **text list** layout — a `Scaffold`
 * under a `TitleBar`, holding a vertical index of tappable text rows.
 *
 * Why this layout and not the text-AND-image list: a trend has no image. There
 * is no avatar, no thumbnail and no per-trend artwork anywhere in the product,
 * so the image-list variant would need a placeholder in every leading slot, and
 * a column of identical placeholders is worse than no column. The structure is
 * otherwise the one Google's Glance samples use for a list — `Scaffold` +
 * `TitleBar` + filled, rounded, individually tappable items — with the leading
 * slot carrying the rank numeral that the app's own trends list already shows.
 *
 * DIMENSIONS. Every value in [TrendsWidgetDimensions] is taken from a source and
 * cited there; none of them is a guess. The two sources are
 * androidx.glance:glance-appwidget's own components and the canonical
 * `ActionListLayout` in Google's `android/platform-samples` repository.
 */

private object TrendsWidgetDimensions {
    /**
     * Padding around the widget's content.
     *
     * `ActionListLayoutDimensions.widgetPadding` in platform-samples
     * (samples/user-interface/appwidgets/.../collections/layout/ActionListLayout.kt),
     * and the same 12dp `Scaffold` itself defaults `horizontalPadding` to.
     */
    val WIDGET_PADDING = 12.dp

    /** `ActionListLayoutDimensions.filledItemCornerRadius`. */
    val ITEM_CORNER_RADIUS = 16.dp

    /** `ActionListLayoutDimensions.filledItemPadding`. */
    val ITEM_HORIZONTAL_PADDING = 12.dp

    /** `ActionListLayoutDimensions.verticalSpacing` — the gap between list items. */
    val ITEM_SPACING = 4.dp

    /** `ActionListLayoutDimensions.itemContentSpacing` — between sections of one item. */
    val ITEM_CONTENT_SPACING = 4.dp

    /**
     * Height of one row, and the reason it is this number: 48dp is Material's
     * minimum touch target, and the whole row is one tap target. It doubles as
     * the unit [maxRows] divides the widget by, so the row count can never
     * produce a row shorter than a finger.
     */
    val ROW_HEIGHT = 48.dp

    /**
     * Height `TitleBar` occupies: its start-icon `Box` is `size(48.dp)` and its
     * `Row` adds `padding(vertical = 4.dp)` (TitleBar.kt in
     * androidx.glance:glance-appwidget), so 48 + 4 + 4.
     */
    val TITLE_BAR_HEIGHT = 56.dp

    /**
     * Below this height the title bar is dropped in favour of another row.
     *
     * `ActionListLayoutSize.showTitleBar` uses exactly this threshold, and it is
     * not an arbitrary one: 180dp is three launcher cells under the `70 × n − 30`
     * conversion in the App Widget sizing guide.
     */
    val TITLE_BAR_MIN_HEIGHT = 180.dp

    /**
     * Below this width the layout goes compact: no rank numeral, no title text,
     * smaller type.
     *
     * Two launcher cells (`70 × 2 − 30`). The canonical sample's own width
     * breakpoint is 260dp, but that number is calibrated for ITS row — a title,
     * two lines of supporting text and two icon buttons. This row is a numeral
     * and one line, so the honest threshold is the point at which the launcher
     * grid itself stops giving the widget room for a leading column.
     */
    val COMPACT_MAX_WIDTH = 180.dp

    /**
     * Width reserved for the rank numeral. Sized to hold two digits at
     * [TrendsWidgetTextStyles]' 14sp so rows stay aligned once the list reaches
     * ten; the widget never renders more than [maxRows] of them anyway.
     */
    val ORDINAL_WIDTH = 20.dp

    /** Gap between the empty state's message and its button; `NoDataContent`'s. */
    val EMPTY_CONTENT_SPACING = 8.dp
}

private object TrendsWidgetTextStyles {
    /**
     * The trend name. 16sp Medium is M3 Title Medium, 14sp Medium is M3 Title
     * Small — the same pair, switched on the same axis, as
     * `ActionListLayoutTextStyles.titleText`.
     */
    @Composable
    fun name(compact: Boolean) = TextStyle(
        color = GlanceTheme.colors.onSecondaryContainer,
        fontWeight = FontWeight.Medium,
        fontSize = if (compact) 14.sp else 16.sp,
    )

    /** Rank numeral and post count: M3 Label Medium, as the sample's supporting text. */
    @Composable
    fun supporting() = TextStyle(
        color = GlanceTheme.colors.onSecondaryContainer,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
    )

    /** The empty state's single line; M3 Title Medium, as `NoDataContent` uses. */
    @Composable
    fun emptyMessage() = TextStyle(
        color = GlanceTheme.colors.onSurface,
        fontWeight = FontWeight.Medium,
        fontSize = 16.sp,
    )
}

/**
 * How many rows fit at this size.
 *
 * Derived rather than tabulated: `n` rows need `n × ROW_HEIGHT` plus the
 * `(n − 1)` gaps between them, inside whatever the title bar and padding leave.
 * That keeps the per-breakpoint row count a consequence of the two cited
 * constants instead of a table someone has to keep in step with them, and it
 * still answers for a size the launcher hands over that no breakpoint declared.
 *
 * At the smallest breakpoint (2×2, 110dp tall) the answer is one row. That is
 * the honest result of a 48dp minimum touch target inside 110dp minus padding —
 * two rows would need 100dp of the 86dp available — not a missing case.
 */
internal fun maxRows(widgetHeight: Dp, showTitleBar: Boolean): Int {
    val chrome = with(TrendsWidgetDimensions) {
        (if (showTitleBar) TITLE_BAR_HEIGHT else WIDGET_PADDING) + WIDGET_PADDING
    }
    val available = widgetHeight - chrome
    val pitch = TrendsWidgetDimensions.ROW_HEIGHT + TrendsWidgetDimensions.ITEM_SPACING
    return ((available + TrendsWidgetDimensions.ITEM_SPACING) / pitch).toInt().coerceAtLeast(1)
}

@Composable
internal fun TrendsWidgetContent(trends: List<WidgetTrend>) {
    val size = LocalSize.current
    val showTitleBar = size.height >= TrendsWidgetDimensions.TITLE_BAR_MIN_HEIGHT
    val compact = size.width < TrendsWidgetDimensions.COMPACT_MAX_WIDTH

    val titleBar: (@Composable () -> Unit)? = if (showTitleBar) {
        { TrendsTitleBar(compact = compact) }
    } else {
        null
    }

    Scaffold(
        backgroundColor = GlanceTheme.colors.widgetBackground,
        // Without a title bar there is nothing above the list, so the padding the
        // title bar would have provided has to come from somewhere. Same
        // arrangement as the canonical ActionListLayout.
        modifier = if (showTitleBar) {
            GlanceModifier
        } else {
            GlanceModifier.padding(top = TrendsWidgetDimensions.WIDGET_PADDING)
        },
        titleBar = titleBar,
    ) {
        Box(GlanceModifier.padding(bottom = TrendsWidgetDimensions.WIDGET_PADDING)) {
            if (trends.isEmpty()) {
                TrendsEmptyContent()
            } else {
                TrendsList(
                    trends = trends,
                    maxRows = maxRows(size.height, showTitleBar),
                    compact = compact,
                )
            }
        }
    }
}

@Composable
private fun TrendsTitleBar(compact: Boolean) {
    val context = LocalContext.current
    TitleBar(
        startIcon = ImageProvider(R.drawable.mention_widget_brand),
        // Dropped when the widget is too narrow to hold the mark, the title and
        // the action without crowding — the sample's own behaviour for its Small
        // breakpoint. The mark still says whose widget this is.
        title = if (compact) "" else context.getString(R.string.mention_trends_widget_title),
        iconColor = GlanceTheme.colors.primary,
        textColor = GlanceTheme.colors.onSurface,
        actions = {
            CircleIconButton(
                imageProvider = ImageProvider(R.drawable.mention_widget_see_all),
                contentDescription = context.getString(R.string.mention_trends_widget_see_all),
                contentColor = GlanceTheme.colors.secondary,
                backgroundColor = null,
                onClick = actionStartActivity(
                    openInAppIntent(context, trendingScreenUrl(context)),
                ),
            )
        },
    )
}

/**
 * The list.
 *
 * A plain [Column] of exactly the rows that fit, not a scrolling lazy list: at
 * one to four items there is nothing to scroll, and a `LazyColumn` would put a
 * RemoteViews collection between the launcher and four rows of text. The
 * breakpoint decides what is shown; the user resizes to see more.
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
 * 48dp touch target, and two lines of type inside 48dp leaves no vertical
 * padding at all. The type of trend is still carried — hashtags keep their `#`
 * and their post count — and the full "Trending topic" / "Trending · N posts"
 * wording lives in the row's content description, so a screen reader hears
 * exactly what the app's list shows.
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
            .cornerRadius(TrendsWidgetDimensions.ITEM_CORNER_RADIUS)
            .background(GlanceTheme.colors.secondaryContainer)
            .padding(horizontal = TrendsWidgetDimensions.ITEM_HORIZONTAL_PADDING)
            .semantics { contentDescription = rowDescription }
            .clickable(actionStartActivity(openInAppIntent(context, trendUrl(context, trend)))),
        verticalAlignment = Alignment.Vertical.CenterVertically,
    ) {
        if (!compact) {
            Text(
                text = ordinal.toString(),
                style = TrendsWidgetTextStyles.supporting(),
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
            style = TrendsWidgetTextStyles.name(compact),
            maxLines = 1,
            modifier = GlanceModifier.defaultWeight().semantics { contentDescription = "" },
        )
        if (trend.kind == TrendKind.HASHTAG && trend.volume > 0) {
            Spacer(GlanceModifier.width(TrendsWidgetDimensions.ITEM_CONTENT_SPACING))
            Text(
                text = formatCompactCount(trend.volume),
                style = TrendsWidgetTextStyles.supporting(),
                maxLines = 1,
                modifier = GlanceModifier.semantics { contentDescription = "" },
            )
        }
    }
}

/**
 * Shown only when there has never been a successful fetch — a failed refresh
 * leaves the previous trends in place, so this is a first-run state rather than
 * an error state, and there is deliberately no spinner: a widget that rests on
 * a spinner is a widget that looks broken every time the user glances at it.
 */
@Composable
private fun TrendsEmptyContent() {
    val context = LocalContext.current
    Column(
        modifier = GlanceModifier.fillMaxSize(),
        verticalAlignment = Alignment.Vertical.CenterVertically,
        horizontalAlignment = Alignment.Horizontal.CenterHorizontally,
    ) {
        Text(
            text = context.getString(R.string.mention_trends_widget_empty),
            style = TrendsWidgetTextStyles.emptyMessage(),
            maxLines = 1,
        )
        Spacer(GlanceModifier.height(TrendsWidgetDimensions.EMPTY_CONTENT_SPACING))
        FilledButton(
            text = context.getString(R.string.mention_trends_widget_open_app),
            onClick = actionStartActivity(openInAppIntent(context, trendingScreenUrl(context))),
            maxLines = 1,
        )
    }
}
