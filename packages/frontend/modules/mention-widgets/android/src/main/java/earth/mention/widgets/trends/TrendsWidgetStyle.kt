package earth.mention.widgets.trends

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.text.FontWeight
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider

/**
 * The measurements and the type scale the three trends widgets share.
 *
 * They differ in how they ARRANGE trends — a ranked list, a cloud of chips, one
 * headline — and agree on how a trend LOOKS. Keeping the agreement in one file is
 * what stops three widgets drifting into three type scales.
 *
 * It is a separate file from `TrendsWidgetChrome.kt`, which holds the shared
 * COMPOSABLES, for the same reason the sparkline's arithmetic is separate from its
 * renderer: everything here can be wrong in a way a test can catch, and nothing here
 * needs a `Context` or a launcher to evaluate.
 *
 * DIMENSIONS. Every value in [TrendsWidgetDimensions] is taken from a source and
 * cited there; none of them is a guess. The two sources are
 * androidx.glance:glance-appwidget's own components and the canonical
 * `ActionListLayout` in Google's `android/platform-samples` repository.
 */

internal object TrendsWidgetDimensions {
    /**
     * Padding around the widget's content.
     *
     * `ActionListLayoutDimensions.widgetPadding` in platform-samples
     * (samples/user-interface/appwidgets/.../collections/layout/ActionListLayout.kt),
     * and the same 12dp `Scaffold` itself defaults `horizontalPadding` to.
     */
    val WIDGET_PADDING = 12.dp

    /** `ActionListLayoutDimensions.verticalSpacing` — the gap between list items. */
    val ITEM_SPACING = 4.dp

    /** `ActionListLayoutDimensions.itemContentSpacing` — between sections of one item. */
    val ITEM_CONTENT_SPACING = 4.dp

    /**
     * Height of one row, and the reason it is this number: 48dp is Material's
     * minimum touch target, and the whole row is one tap target. It doubles as
     * the unit [rowsThatFit] divides the widget by, so the row count can never
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
     * Below this height the title bar is dropped in favour of content.
     *
     * `ActionListLayoutSize.showTitleBar` uses exactly this threshold, and it is
     * not an arbitrary one: 180dp is three launcher cells under the `70 × n − 30`
     * conversion in the App Widget sizing guide.
     */
    val TITLE_BAR_MIN_HEIGHT = 180.dp

    /**
     * Below this width every variant goes compact: smaller type, and whatever
     * secondary content it can drop.
     *
     * Two launcher cells (`70 × 2 − 30`). The canonical sample's own width
     * breakpoint is 260dp, but that number is calibrated for ITS row — a title,
     * two lines of supporting text and two icon buttons. These rows are a name and
     * one line, so the honest threshold is the point at which the launcher grid
     * itself stops giving the widget room for a leading column.
     */
    val COMPACT_MAX_WIDTH = 180.dp

    /**
     * Width reserved for the rank numeral. Sized to hold two digits at the
     * supporting style's 12sp so rows stay aligned once the list reaches ten; no
     * variant renders more than four rows anyway.
     */
    val ORDINAL_WIDTH = 20.dp

    /** Gap between the empty state's message and its button; `NoDataContent`'s. */
    val EMPTY_CONTENT_SPACING = 8.dp
}

/**
<<<<<<< HEAD
=======
 * The type scale's sizes, in sp, as plain numbers.
 *
 * They exist because a layout on this surface sometimes has to MEASURE text rather than
 * just style it — Glance cannot measure, so how much fits is estimated from the font
 * size before anything is emitted (`estimateTextWidthDp`, [estimateLineHeightDp]) — and
 * a measurement taken against a different number than the one drawn is a layout that
 * silently disagrees with itself.
 *
 * So this is the single source: [TrendsWidgetTextStyles] builds every `TextStyle` from
 * these values, and the layouts that measure read the same ones.
 */
internal object TrendsWidgetFontSizes {
    /** M3 Title Medium / Title Small — a trend's name in a list row or a chip. */
    const val NAME = 16f
    const val NAME_COMPACT = 14f

    /** M3 Headline Small, and the compact step for a surface too small to hold it. */
    const val HEADLINE = 26f
    const val HEADLINE_COMPACT = 20f

    /** M3 Label Medium — a rank numeral, a post count, the line under a headline. */
    const val SUPPORTING = 12f

    /** M3 Label Small — the card's eyebrow. */
    const val EYEBROW = 11f

    /** M3 Title Medium — the empty state's single line. */
    const val EMPTY_MESSAGE = 16f
}

/**
 * Height one line of text occupies, as a fraction of its font size.
 *
 * A `TextView` reserves ascent plus descent INCLUDING the font's own padding
 * (`includeFontPadding`, on by default and not reachable from Glance), which for Roboto
 * is a little over 1.28em rather than the 1.17em its bare ascent and descent come to.
 * 1.3 is that rounded up, which claims slightly less room than there is — the safe
 * direction, since over-estimating costs a line that is dropped and under-estimating
 * costs a line that is clipped.
 */
private const val LINE_HEIGHT_RATIO = 1.3f

/**
 * Roughly how tall one line of [fontSizeSp] text renders, in dp.
 *
 * The height counterpart to `estimateTextWidthDp`, and [fontScale] is here for the same
 * reason it is there: a layout that ignores the reader's font setting is a layout that
 * breaks for the readers who need it most. Android 14's non-linear scaling steps large
 * type up by less than this assumes, which again errs towards claiming less room.
 *
 * It is shared because two variants need it — the card's short form and the list's lead
 * are the same two lines of type, and each has to know whether the second one fits
 * inside its own padding.
 */
internal fun estimateLineHeightDp(fontSizeSp: Float, fontScale: Float): Float =
    fontSizeSp * fontScale * LINE_HEIGHT_RATIO

/**
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
 * The type scale, as Material 3 roles.
 *
 * Colour is a parameter rather than a constant because the same text is drawn on
 * two different surfaces across the three variants — on the widget background
 * (`onSurface`) in the list and chip clouds, inside a tonal container
 * (`onPrimaryContainer`) in the card — and a style that hardcoded one would be
 * unreadable on the other.
 */
internal object TrendsWidgetTextStyles {
    /**
     * A trend's name in a list or a chip. 16sp Medium is M3 Title Medium, 14sp
     * Medium is M3 Title Small — the same pair, switched on the same axis, as
     * `ActionListLayoutTextStyles.titleText`.
     */
    fun name(color: ColorProvider, compact: Boolean) = TextStyle(
        color = color,
        fontWeight = FontWeight.Medium,
<<<<<<< HEAD
        fontSize = if (compact) 14.sp else 16.sp,
=======
        fontSize = if (compact) {
            TrendsWidgetFontSizes.NAME_COMPACT.sp
        } else {
            TrendsWidgetFontSizes.NAME.sp
        },
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
    )

    /**
     * The one trend a widget leads with, when it has the room to lead with one:
     * M3 Headline Small at 26sp, dropping to a compact 20sp where the width cannot
     * hold it.
     *
     * Material 3 Expressive's emphasis is carried here — a genuinely large, heavier
     * headline — rather than through motion or shape morphing, neither of which a
     * `RemoteViews` surface can do at all.
     */
    fun headline(color: ColorProvider, compact: Boolean) = TextStyle(
        color = color,
        fontWeight = FontWeight.Bold,
<<<<<<< HEAD
        fontSize = if (compact) 20.sp else 26.sp,
=======
        fontSize = if (compact) {
            TrendsWidgetFontSizes.HEADLINE_COMPACT.sp
        } else {
            TrendsWidgetFontSizes.HEADLINE.sp
        },
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
    )

    /** Rank numeral, post count, the line under a headline: M3 Label Medium. */
    fun supporting(color: ColorProvider) = TextStyle(
        color = color,
        fontWeight = FontWeight.Normal,
<<<<<<< HEAD
        fontSize = 12.sp,
=======
        fontSize = TrendsWidgetFontSizes.SUPPORTING.sp,
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
    )

    /**
     * The card's eyebrow: M3 Label Small, Medium weight.
     *
     * Its all-caps treatment lives in the string resource, not here — Glance's
     * `TextStyle` has no letter-spacing or text-transform, and a widget cannot
     * uppercase per locale correctly without one.
     */
    fun eyebrow(color: ColorProvider) = TextStyle(
        color = color,
        fontWeight = FontWeight.Medium,
<<<<<<< HEAD
        fontSize = 11.sp,
=======
        fontSize = TrendsWidgetFontSizes.EYEBROW.sp,
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
    )

    /** The empty state's single line; M3 Title Medium, as `NoDataContent` uses. */
    fun emptyMessage(color: ColorProvider) = TextStyle(
        color = color,
        fontWeight = FontWeight.Medium,
<<<<<<< HEAD
        fontSize = 16.sp,
=======
        fontSize = TrendsWidgetFontSizes.EMPTY_MESSAGE.sp,
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
    )
}

/**
 * How many rows of [rowHeight] fit in a widget this tall.
 *
 * Derived rather than tabulated: `n` rows need `n × rowHeight` plus the `(n − 1)`
 * gaps between them, inside whatever the title bar and padding leave. That keeps
 * every per-breakpoint count a consequence of the cited constants instead of a
 * table someone has to keep in step with them, and it still answers for a size the
 * launcher hands over that no breakpoint declared.
 *
 * Never returns less than one: a widget that fits nothing still has to draw
 * something, and each variant decides what the one-row answer means for it — for
 * the ranked list it is the signal to stop being a list at all (see
 * `TrendsListLayout`).
 */
internal fun rowsThatFit(
    widgetHeight: Dp,
    showTitleBar: Boolean,
    rowHeight: Dp,
    rowSpacing: Dp,
): Int {
    val chrome = with(TrendsWidgetDimensions) {
        (if (showTitleBar) TITLE_BAR_HEIGHT else WIDGET_PADDING) + WIDGET_PADDING
    }
    val available = widgetHeight - chrome
    val pitch = rowHeight + rowSpacing
    return ((available + rowSpacing) / pitch).toInt().coerceAtLeast(1)
}
