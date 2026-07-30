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
        fontSize = if (compact) 14.sp else 16.sp,
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
        fontSize = if (compact) 20.sp else 26.sp,
    )

    /** Rank numeral, post count, the line under a headline: M3 Label Medium. */
    fun supporting(color: ColorProvider) = TextStyle(
        color = color,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
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
        fontSize = 11.sp,
    )

    /** The empty state's single line; M3 Title Medium, as `NoDataContent` uses. */
    fun emptyMessage(color: ColorProvider) = TextStyle(
        color = color,
        fontWeight = FontWeight.Medium,
        fontSize = 16.sp,
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
