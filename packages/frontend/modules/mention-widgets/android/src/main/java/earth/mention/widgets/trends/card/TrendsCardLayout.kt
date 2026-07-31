package earth.mention.widgets.trends.card

import androidx.compose.runtime.Composable
<<<<<<< HEAD
=======
import androidx.compose.ui.unit.Dp
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
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
<<<<<<< HEAD
import earth.mention.widgets.trends.TrendsWidgetDimensions
import earth.mention.widgets.trends.TrendsWidgetTextStyles
import earth.mention.widgets.trends.WidgetTrend
=======
import earth.mention.widgets.trends.TrendsWidgetFontSizes
import earth.mention.widgets.trends.TrendsWidgetDimensions
import earth.mention.widgets.trends.TrendsWidgetTextStyles
import earth.mention.widgets.trends.WidgetTrend
import earth.mention.widgets.trends.estimateLineHeightDp
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
import earth.mention.widgets.trends.estimateTextWidthDp
import earth.mention.widgets.trends.leadingSeries
import earth.mention.widgets.trends.openInAppIntent
import earth.mention.widgets.trends.packRows
import earth.mention.widgets.trends.trendDisplayName
import earth.mention.widgets.trends.trendLabel
import earth.mention.widgets.trends.trendUrl
<<<<<<< HEAD
=======
import earth.mention.widgets.trends.trendingScreenUrl
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)

/**
 * Variant J — the FULL-BLEED TONAL CARD: the whole widget is one tonal container
 * holding an eyebrow, the top trend as a headline, and the next few as one compact
 * line, over that top trend's chart.
 *
 * This is the variant where the chart is unambiguous: there is one headline, and the
 * chart is its history. The other two show several trends and one chart, which the
 * chart's low emphasis and the leading trend's position have to carry.
 *
<<<<<<< HEAD
=======
 * It is also the variant that can be dragged down to a single cell of height, which the
 * other two cannot: they are lists, and a list of one row reads as a list that failed to
 * load. A card of one trend is still a card of one trend, so the short form keeps the
 * name and its volume and gives up everything around them — [TrendsCardDensity].
 *
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
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
<<<<<<< HEAD
=======
 * How much of the card a placement of a given height has room for.
 *
 * The card's variable is not how many trends it lists — it always leads with exactly
 * one — but how much of the frame around that trend survives. Each step down drops the
 * least load-bearing thing left, so a shorter card shows LESS rather than the same
 * content squeezed. The sizes each form is declared at are in `TrendsCardWidget`.
 */
internal enum class TrendsCardDensity {
    /**
     * The trend and its volume, centred, and nothing else: no eyebrow, no
     * runners-up, no chart. One launcher cell of height.
     */
    SHORT,

    /** The eyebrow, the headline and its supporting line, over the chart. */
    STANDARD,

    /** The same, plus the line of runners-up. */
    FULL,
}

/**
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
 * Below this height the card drops its secondary line.
 *
 * Three launcher cells (`70 × 3 − 30`) — the same grid threshold at which the other
 * two variants gain their title bar. Under it there is room for the eyebrow, the
 * headline and its supporting line, and taking a fourth element in would leave all
 * four cramped.
 */
private val SECONDARY_LINE_MIN_HEIGHT = 180.dp

/**
<<<<<<< HEAD
=======
 * At or above this height the card shows its standard form.
 *
 * Two launcher cells (`70 × 2 − 30`), which is both the card's default placement and
 * what its three stacked text elements need: at 1.3× their font size, an 11sp eyebrow,
 * a 26sp headline and a 12sp supporting line come to 63.7dp inside 32dp of padding.
 */
private val STANDARD_MIN_HEIGHT = 110.dp

/**
 * The shortest height the card is designed for — the value
 * `mention_trends_card_widget_min_resize_height` gives the launcher as its resize floor,
 * derived in the note on that dimen.
 *
 * With `SizeMode.Exact` nothing is declared to Glance, so this is not a breakpoint: it is
 * the smallest height the short form was designed against, and the height the tests
 * measure that design at. `TrendsBreakpointsTest` holds it to the dimen, since a Glance
 * layout cannot read a dimen and the provider XML cannot read Kotlin.
 */
internal val TRENDS_CARD_SHORT_HEIGHT = 60.dp

/**
 * Which form a card of this height gets.
 *
 * Height only — the card's WIDTH decides its type size, its height decides how many of
 * its parts are drawn at all.
 *
 * The thresholds are inclusive floors, and with `SizeMode.Exact` they are compared
 * against the card's REAL height — so a 100dp card gets the standard form because 100dp
 * holds it, where a declared-size set would have handed it the 60dp form and dropped the
 * eyebrow from a card with room for one.
 */
internal fun trendsCardDensity(height: Dp): TrendsCardDensity = when {
    height >= SECONDARY_LINE_MIN_HEIGHT -> TrendsCardDensity.FULL
    height >= STANDARD_MIN_HEIGHT -> TrendsCardDensity.STANDARD
    else -> TrendsCardDensity.SHORT
}

/**
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
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

<<<<<<< HEAD
=======
/**
 * Padding inside the card at the short height.
 *
 * 8dp rather than the 12dp the compact width falls back to, because height is the axis
 * the short form has none of to spare: at 60dp, 12dp top and bottom is two fifths of
 * the card. It is still a step of Material's 4dp grid, and the same 8dp this module's
 * other stacked blocks are spaced by.
 */
private val SHORT_CARD_PADDING = 8.dp

>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
/** Gap either side of the dot between two names on the secondary line. */
private val SECONDARY_SEPARATOR_GAP = 4.dp

/** The separator itself. Not localized: it is punctuation, and the same glyph the app's own metadata rows use. */
private const val SECONDARY_SEPARATOR = "·"

<<<<<<< HEAD
/** Font size the secondary line's names draw at; M3 Title Small, as `TrendsWidgetTextStyles.name(compact = true)`. */
private const val SECONDARY_NAME_FONT_SP = 14f

/** Font size the separator draws at; M3 Label Medium, as `TrendsWidgetTextStyles.supporting()`. */
private const val SECONDARY_SEPARATOR_FONT_SP = 12f
=======

/**
 * Whether the short form has room for its supporting line as well as the trend's name.
 *
 * The one layout decision in this module that turns on the reader's font setting, and
 * it is here because the short form is the first breakpoint with no slack: at the 60dp
 * floor the two lines occupy 41.6dp of a 44dp content box, so one step up the font
 * scale is enough to push the second past the bottom edge — where a `RemoteViews` does
 * not shrink it, wrap it or scroll it, it clips it.
 *
 * So the line is dropped and the trend's name, the reason the widget exists, is left
 * whole. Nothing is lost to a screen reader: the label is part of the headline's content
 * description, not only of the text it draws.
 *
 * It is measured against the card's REAL height, which is what `SizeMode.Exact` gives
 * it, so the line is dropped only on a card that genuinely cannot hold it — never on one
 * that a declared breakpoint merely rounded down.
 */
internal fun shortCardShowsSupportingLine(cardHeight: Dp, fontScale: Float): Boolean {
    val available = cardHeight.value - SHORT_CARD_PADDING.value * 2
    val text = estimateLineHeightDp(TrendsWidgetFontSizes.HEADLINE_COMPACT, fontScale) +
        estimateLineHeightDp(TrendsWidgetFontSizes.SUPPORTING, fontScale)
    return text <= available
}
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)

@Composable
internal fun TrendsCardWidgetContent(trends: List<WidgetTrend>) {
    val context = LocalContext.current
    val size = LocalSize.current
<<<<<<< HEAD
    val compact = size.width < TrendsWidgetDimensions.COMPACT_MAX_WIDTH
    val padding = if (compact) TrendsWidgetDimensions.WIDGET_PADDING else CARD_PADDING
=======
    val density = trendsCardDensity(size.height)
    val short = density == TrendsCardDensity.SHORT
    val compact = size.width < TrendsWidgetDimensions.COMPACT_MAX_WIDTH
    // The reader's font-size setting. Read once: both the secondary line's packing and
    // the short form's room check are measured against it.
    val fontScale = context.resources.configuration.fontScale
    val padding = when {
        short -> SHORT_CARD_PADDING
        compact -> TrendsWidgetDimensions.WIDGET_PADDING
        else -> CARD_PADDING
    }
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
    val onContainer = GlanceTheme.colors.onPrimaryContainer

    Scaffold(
        // The tonal container IS the widget — there is no chrome outside it.
        backgroundColor = GlanceTheme.colors.primaryContainer,
        // The chart reaches the card's edges; the content pads itself.
        horizontalPadding = 0.dp,
    ) {
        Box(GlanceModifier.fillMaxSize()) {
<<<<<<< HEAD
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
=======
            // NO CHART at the short height, and this is a legibility decision before it
            // is a payload one. The band has a 40dp floor — under that a curve has no
            // shape left — so on a 60dp card it is two thirds of the surface and stops
            // being a band behind the text to become a backdrop under it, with the one
            // line that matters drawn straight across the stroke. The chart is the
            // card's supporting element; when only one of the two can be legible, the
            // trend's name wins. It costs the shortest breakpoints nothing in the
            // `RemoteViews` as a consequence, rather than as the reason.
            if (!short) {
                SparklineBackground(leadingSeries(trends), onContainer)
            }
            Box(GlanceModifier.fillMaxSize().padding(padding)) {
                when {
                    trends.isEmpty() && short -> CardShortEmptyContent(contentColor = onContainer)
                    trends.isEmpty() -> TrendsEmptyContent(textColor = onContainer)
                    else -> CardBody(
                        trends = trends,
                        density = density,
                        // The short form takes the compact headline at EVERY width: the
                        // 26sp one plus a supporting line needs 49dp of the 44dp this
                        // card has, so here the type size is decided by the height that
                        // is scarce rather than by the width that is not.
                        compact = compact || short,
                        showSupportingLine = !short ||
                            shortCardShowsSupportingLine(size.height, fontScale),
                        availableWidthDp = size.width.value - padding.value * 2,
                        fontScale = fontScale,
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
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
<<<<<<< HEAD
    compact: Boolean,
    showSecondaryLine: Boolean,
=======
    density: TrendsCardDensity,
    compact: Boolean,
    showSupportingLine: Boolean,
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
    availableWidthDp: Float,
    fontScale: Float,
    contentColor: ColorProvider,
) {
    Column(modifier = GlanceModifier.fillMaxSize()) {
<<<<<<< HEAD
        CardHeadline(trend = trends.first(), compact = compact, contentColor = contentColor)

        val rest = trends.drop(1)
        if (showSecondaryLine && rest.isNotEmpty()) {
=======
        CardHeadline(
            trend = trends.first(),
            density = density,
            compact = compact,
            showSupportingLine = showSupportingLine,
            contentColor = contentColor,
        )

        val rest = trends.drop(1)
        if (density == TrendsCardDensity.FULL && rest.isNotEmpty()) {
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
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
<<<<<<< HEAD
 */
@Composable
private fun CardHeadline(trend: WidgetTrend, compact: Boolean, contentColor: ColorProvider) {
    val context = LocalContext.current
=======
 *
 * WHAT THE SHORT FORM DROPS, and why in this order. The eyebrow goes first because it
 * is the only element that says nothing a reader cannot already see: the supporting line
 * under it opens with the same word ("Trending · 1.2K posts"), and the widget is called
 * "Top trend" in the picker. The supporting line goes next, and only when the reader's
 * font setting leaves no room for it — see [shortCardShowsSupportingLine]. The name is
 * never dropped; a card without it would not be a card about a trend.
 *
 * The short form also fills the card and centres itself rather than stacking from the
 * top, for two reasons: the chart it would otherwise avoid is not drawn at this height,
 * and the whole 60dp becomes the tap target, where the two lines alone would be 42dp of
 * one — under Material's 48dp minimum.
 */
@Composable
private fun CardHeadline(
    trend: WidgetTrend,
    density: TrendsCardDensity,
    compact: Boolean,
    showSupportingLine: Boolean,
    contentColor: ColorProvider,
) {
    val context = LocalContext.current
    val short = density == TrendsCardDensity.SHORT
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
    val name = trendDisplayName(trend)
    val label = trendLabel(context, trend)

    Column(
<<<<<<< HEAD
        modifier = GlanceModifier
            .fillMaxWidth()
=======
        modifier = (if (short) GlanceModifier.fillMaxSize() else GlanceModifier.fillMaxWidth())
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
            .semantics {
                contentDescription = context.getString(
                    R.string.mention_trends_widget_item_description,
                    name,
                    label,
                )
            }
            .clickable(actionStartActivity(openInAppIntent(context, trendUrl(context, trend)))),
<<<<<<< HEAD
    ) {
        Text(
            text = context.getString(R.string.mention_trends_widget_eyebrow),
            style = TrendsWidgetTextStyles.eyebrow(contentColor),
            maxLines = 1,
            modifier = GlanceModifier.semantics { contentDescription = "" },
        )
=======
        verticalAlignment = if (short) {
            Alignment.Vertical.CenterVertically
        } else {
            Alignment.Vertical.Top
        },
    ) {
        if (!short) {
            Text(
                text = context.getString(R.string.mention_trends_widget_eyebrow),
                style = TrendsWidgetTextStyles.eyebrow(contentColor),
                maxLines = 1,
                modifier = GlanceModifier.semantics { contentDescription = "" },
            )
        }
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
        Text(
            text = name,
            style = TrendsWidgetTextStyles.headline(contentColor, compact),
            maxLines = 1,
            modifier = GlanceModifier.semantics { contentDescription = "" },
        )
<<<<<<< HEAD
        Text(
            text = label,
            style = TrendsWidgetTextStyles.supporting(contentColor),
            maxLines = 1,
            modifier = GlanceModifier.semantics { contentDescription = "" },
=======
        if (showSupportingLine) {
            Text(
                text = label,
                style = TrendsWidgetTextStyles.supporting(contentColor),
                maxLines = 1,
                modifier = GlanceModifier.semantics { contentDescription = "" },
            )
        }
    }
}

/**
 * The first-run state at the short height: the message alone, and it is the tap target.
 *
 * `TrendsEmptyContent`'s message-over-button stack needs about 75dp of content height
 * and this form has 44dp, so the button would be clipped — and a half-drawn button is
 * worse than no button. The line itself opens the app, which is where that button led.
 */
@Composable
private fun CardShortEmptyContent(contentColor: ColorProvider) {
    val context = LocalContext.current
    Box(
        modifier = GlanceModifier
            .fillMaxSize()
            .clickable(
                actionStartActivity(openInAppIntent(context, trendingScreenUrl(context))),
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = context.getString(R.string.mention_trends_widget_empty),
            style = TrendsWidgetTextStyles.emptyMessage(contentColor),
            maxLines = 1,
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
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
<<<<<<< HEAD
        estimateTextWidthDp(SECONDARY_SEPARATOR, SECONDARY_SEPARATOR_FONT_SP, fontScale)
    return packRows(
        widths = names.map { estimateTextWidthDp(it, SECONDARY_NAME_FONT_SP, fontScale) },
=======
        estimateTextWidthDp(SECONDARY_SEPARATOR, TrendsWidgetFontSizes.SUPPORTING, fontScale)
    return packRows(
        widths = names.map {
            estimateTextWidthDp(it, TrendsWidgetFontSizes.NAME_COMPACT, fontScale)
        },
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
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
