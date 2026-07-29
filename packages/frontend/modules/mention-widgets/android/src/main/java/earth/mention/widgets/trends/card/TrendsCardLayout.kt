package earth.mention.widgets.trends.card

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
import androidx.glance.unit.ColorProvider
import earth.mention.widgets.R
import earth.mention.widgets.sparkline.SparklineBackground
import earth.mention.widgets.trends.TrendsEmptyContent
import earth.mention.widgets.trends.TrendsWidgetDimensions
import earth.mention.widgets.trends.TrendsWidgetTextStyles
import earth.mention.widgets.trends.WidgetTrend
import earth.mention.widgets.trends.estimateTextWidthDp
import earth.mention.widgets.trends.leadingSeries
import earth.mention.widgets.trends.openInAppIntent
import earth.mention.widgets.trends.packRows
import earth.mention.widgets.trends.trendDisplayName
import earth.mention.widgets.trends.trendLabel
import earth.mention.widgets.trends.trendUrl

/**
 * Variant J — the FULL-BLEED TONAL CARD: the whole widget is one tonal container
 * holding an eyebrow, the top trend as a headline, and the next few as one compact
 * line, over that top trend's chart.
 *
 * This is the variant where the chart is unambiguous: there is one headline, and the
 * chart is its history. The other two show several trends and one chart, which the
 * chart's low emphasis and the leading trend's position have to carry.
 *
 * THE CORNER. Material 3 Expressive's largest corner is ~30dp, but this card does not
 * set one: `Scaffold` applies `android.R.dimen.system_app_widget_background_radius`
 * on API 31+, which is the radius the LAUNCHER itself clips widgets to. A hand-set
 * 30dp inside a launcher clipping at 24dp draws a second, mismatched curve just
 * inside the first — the system value is both the canonical answer and the only one
 * that cannot disagree with the host.
 *
 * What Expressive contributes that a `RemoteViews` surface can actually honour: the
 * tonal container, the emphasised headline, dynamic wallpaper colour. Not shape
 * morphing and not springy motion — a widget does not animate, and Glance's brush and
 * gradient additions are Wear-only.
 */

/**
 * Below this height the card drops its secondary line.
 *
 * Three launcher cells (`70 × 3 − 30`) — the same grid threshold at which the other
 * two variants gain their title bar. Under it there is room for the eyebrow, the
 * headline and its supporting line, and taking a fourth element in would leave all
 * four cramped.
 */
private val SECONDARY_LINE_MIN_HEIGHT = 180.dp

/**
 * The secondary line is one tap target per trend, so it gets the same 48dp minimum
 * as a list row or a chip.
 */
private val SECONDARY_LINE_HEIGHT = 48.dp

/**
 * Padding inside the card.
 *
 * 16dp is M3's card content padding. At the compact width the card is 110dp across
 * and 32dp of that is a third of the headline's room, so it falls back to the 12dp
 * every other widget surface here uses.
 */
private val CARD_PADDING = 16.dp

/** Gap either side of the dot between two names on the secondary line. */
private val SECONDARY_SEPARATOR_GAP = 4.dp

/** The separator itself. Not localized: it is punctuation, and the same glyph the app's own metadata rows use. */
private const val SECONDARY_SEPARATOR = "·"

/** Font size the secondary line's names draw at; M3 Title Small, as `TrendsWidgetTextStyles.name(compact = true)`. */
private const val SECONDARY_NAME_FONT_SP = 14f

/** Font size the separator draws at; M3 Label Medium, as `TrendsWidgetTextStyles.supporting()`. */
private const val SECONDARY_SEPARATOR_FONT_SP = 12f

@Composable
internal fun TrendsCardWidgetContent(trends: List<WidgetTrend>) {
    val context = LocalContext.current
    val size = LocalSize.current
    val compact = size.width < TrendsWidgetDimensions.COMPACT_MAX_WIDTH
    val padding = if (compact) TrendsWidgetDimensions.WIDGET_PADDING else CARD_PADDING
    val onContainer = GlanceTheme.colors.onPrimaryContainer

    Scaffold(
        // The tonal container IS the widget — there is no chrome outside it.
        backgroundColor = GlanceTheme.colors.primaryContainer,
        // The chart reaches the card's edges; the content pads itself.
        horizontalPadding = 0.dp,
    ) {
        Box(GlanceModifier.fillMaxSize()) {
            SparklineBackground(leadingSeries(trends), onContainer)
            Box(GlanceModifier.fillMaxSize().padding(padding)) {
                if (trends.isEmpty()) {
                    TrendsEmptyContent(textColor = onContainer)
                } else {
                    CardBody(
                        trends = trends,
                        compact = compact,
                        showSecondaryLine = size.height >= SECONDARY_LINE_MIN_HEIGHT,
                        availableWidthDp = size.width.value - padding.value * 2,
                        fontScale = context.resources.configuration.fontScale,
                        contentColor = onContainer,
                    )
                }
            }
        }
    }
}

@Composable
private fun CardBody(
    trends: List<WidgetTrend>,
    compact: Boolean,
    showSecondaryLine: Boolean,
    availableWidthDp: Float,
    fontScale: Float,
    contentColor: ColorProvider,
) {
    Column(modifier = GlanceModifier.fillMaxSize()) {
        CardHeadline(trend = trends.first(), compact = compact, contentColor = contentColor)

        val rest = trends.drop(1)
        if (showSecondaryLine && rest.isNotEmpty()) {
            // Pushes the line to the bottom edge of the content, so the headline
            // stays anchored at the top and the space between them absorbs whatever
            // height the placement actually has.
            Spacer(GlanceModifier.defaultWeight())
            CardSecondaryLine(
                trends = rest,
                availableWidthDp = availableWidthDp,
                fontScale = fontScale,
                contentColor = contentColor,
            )
        }
    }
}

/**
 * The eyebrow, the trend, and what it is doing — one tap target, opening that trend.
 */
@Composable
private fun CardHeadline(trend: WidgetTrend, compact: Boolean, contentColor: ColorProvider) {
    val context = LocalContext.current
    val name = trendDisplayName(trend)
    val label = trendLabel(context, trend)

    Column(
        modifier = GlanceModifier
            .fillMaxWidth()
            .semantics {
                contentDescription = context.getString(
                    R.string.mention_trends_widget_item_description,
                    name,
                    label,
                )
            }
            .clickable(actionStartActivity(openInAppIntent(context, trendUrl(context, trend)))),
    ) {
        Text(
            text = context.getString(R.string.mention_trends_widget_eyebrow),
            style = TrendsWidgetTextStyles.eyebrow(contentColor),
            maxLines = 1,
            modifier = GlanceModifier.semantics { contentDescription = "" },
        )
        Text(
            text = name,
            style = TrendsWidgetTextStyles.headline(contentColor, compact),
            maxLines = 1,
            modifier = GlanceModifier.semantics { contentDescription = "" },
        )
        Text(
            text = label,
            style = TrendsWidgetTextStyles.supporting(contentColor),
            maxLines = 1,
            modifier = GlanceModifier.semantics { contentDescription = "" },
        )
    }
}

/**
 * The trends after the headline, as many as fit on one line, each one tappable.
 *
 * Which ones fit is decided by [packRows] over estimated widths, the same machinery
 * the chip cloud uses and for the same reason — Glance cannot measure text. Here the
 * consequence of a wrong estimate is one name more or fewer on the line; the names
 * are not stretched, because a run of names separated by dots reads as a sentence and
 * a stretched one would not.
 */
@Composable
private fun CardSecondaryLine(
    trends: List<WidgetTrend>,
    availableWidthDp: Float,
    fontScale: Float,
    contentColor: ColorProvider,
) {
    val context = LocalContext.current
    val names = trends.map { trendDisplayName(it) }
    val fitted = cardSecondaryNamesThatFit(names, availableWidthDp, fontScale)

    Row(
        modifier = GlanceModifier.fillMaxWidth().height(SECONDARY_LINE_HEIGHT),
        verticalAlignment = Alignment.Vertical.CenterVertically,
    ) {
        fitted.forEachIndexed { position, index ->
            if (position != 0) {
                CardSecondarySeparator(contentColor = contentColor)
            }
            val trend = trends[index]
            val name = names[index]
            Text(
                text = name,
                style = TrendsWidgetTextStyles.name(contentColor, compact = true),
                maxLines = 1,
                modifier = GlanceModifier
                    .semantics {
                        contentDescription = context.getString(
                            R.string.mention_trends_widget_item_description,
                            name,
                            trendLabel(context, trend),
                        )
                    }
                    .clickable(
                        actionStartActivity(openInAppIntent(context, trendUrl(context, trend))),
                    ),
            )
        }
    }
}

/**
 * Which of [names] fit on the secondary line, as indices into it.
 *
 * One row, so this is [packRows] with `maxRows = 1`. The spacing between two names is
 * not a gap but the separator and the space either side of it, which is why it is
 * measured through the same estimator as the names themselves rather than being a
 * constant — a reader on a large font setting gets a wider dot too.
 */
internal fun cardSecondaryNamesThatFit(
    names: List<String>,
    availableWidthDp: Float,
    fontScale: Float,
): List<Int> {
    val separatorWidth = SECONDARY_SEPARATOR_GAP.value * 2 +
        estimateTextWidthDp(SECONDARY_SEPARATOR, SECONDARY_SEPARATOR_FONT_SP, fontScale)
    return packRows(
        widths = names.map { estimateTextWidthDp(it, SECONDARY_NAME_FONT_SP, fontScale) },
        availableWidthDp = availableWidthDp,
        maxRows = 1,
        spacingDp = separatorWidth,
    ).firstOrNull().orEmpty()
}

@Composable
private fun CardSecondarySeparator(contentColor: ColorProvider) {
    Spacer(GlanceModifier.width(SECONDARY_SEPARATOR_GAP))
    Text(
        text = SECONDARY_SEPARATOR,
        style = TrendsWidgetTextStyles.supporting(contentColor),
        maxLines = 1,
        // Punctuation between two names; a screen reader reads the names.
        modifier = GlanceModifier.semantics { contentDescription = "" },
    )
    Spacer(GlanceModifier.width(SECONDARY_SEPARATOR_GAP))
}
