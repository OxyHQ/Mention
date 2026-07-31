package earth.mention.widgets.posts

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.text.FontWeight
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import earth.mention.widgets.trends.AVERAGE_GLYPH_WIDTH_RATIO

/**
 * The trending-posts card's MEASUREMENTS and its BREAKPOINTS.
 *
 * Everything in this file is decided without a `Context`, a `Canvas` or a composition,
 * which is the point: the per-breakpoint decisions are the ones that can be wrong in a
 * way nobody notices until a widget is resized on a real home screen, so they are
 * written as pure functions and unit tested.
 *
 * The card is DESIGNED PER SIZE rather than stretched. Three sizes, and each one drops
 * something rather than squeezing everything:
 *
 *   250 × 110dp  (4×2)  SMALL   brand row, two lines of text, byline. NO image, and
 *                                no advance control or pips — see [showsAdvanceControl].
 *   250 × 180dp  (4×3)  MEDIUM  the same, plus an image slot, the pips and the
 *                                advance control.                     (the default)
 *   320 × 320dp  (5×5)  LARGE   more text, a taller image slot, and the only design
 *                                whose byline still has room for the author's handle.
 *
 * Three, and no more, because `SizeMode.Responsive` composes EVERY declared size into
 * the single `RemoteViews` the launcher receives — and this widget's `RemoteViews`
 * carries decoded bitmaps. A fourth breakpoint is a fourth avatar and a fourth
 * thumbnail in the same payload, which is the shape that makes a widget render blank
 * rather than merely imperfect. See [POSTS_WORST_CASE_BITMAP_BYTES].
 */

/** Which of the three designs a given placement gets. */
internal enum class PostsCardSize {
    SMALL,
    MEDIUM,
    LARGE,
}

/**
 * The sizes the widget DECLARES to `SizeMode.Responsive` — one per design, and the
 * single source for both the widget's declaration and the payload arithmetic in
 * `PostsBitmaps.kt`.
 *
 * Keeping one list is what makes [POSTS_WORST_CASE_BITMAP_BYTES] trustworthy: a fourth
 * breakpoint added here immediately shows up in that number and in the test that bounds
 * it, instead of quietly enlarging a payload nobody is measuring.
 */
internal val POSTS_WIDGET_SIZES: Set<DpSize> = setOf(
    DpSize(250.dp, 110.dp),
    DpSize(250.dp, 180.dp),
    DpSize(320.dp, 320.dp),
)

/**
 * Cell-grid thresholds, in the launcher's own `70 × cells − 30` dp conversion
 * (developer.android.com/develop/ui/views/appwidgets § "Determine widget sizing"):
 * 2 cells → 110dp, 3 → 180dp, 4 → 250dp, 5 → 320dp.
 */
private val MEDIUM_MIN_HEIGHT = 180.dp
private val LARGE_MIN_HEIGHT = 320.dp
private val LARGE_MIN_WIDTH = 320.dp

/**
 * Which design a placement of this size gets.
 *
 * Height leads, because what the card gains with room is the IMAGE, and an image needs
 * vertical space. The large design additionally asks for the width, since its taller
 * image slot on a narrow widget would leave the text with a strip.
 *
 * A launcher may hand over a size no breakpoint declared, so the boundaries are
 * inclusive floors rather than equality tests against the declared set.
 */
internal fun postsCardSize(width: Dp, height: Dp): PostsCardSize = when {
    height >= LARGE_MIN_HEIGHT && width >= LARGE_MIN_WIDTH -> PostsCardSize.LARGE
    height >= MEDIUM_MIN_HEIGHT -> PostsCardSize.MEDIUM
    else -> PostsCardSize.SMALL
}

internal object PostsCardDimensions {
    /**
     * Padding inside the card. M3's card content padding is 16dp; the small design
     * falls back to the 12dp every other widget surface in this module uses, because
     * at 250dp wide 32dp of horizontal padding is an eighth of the card.
     */
    val PADDING = 16.dp
    val PADDING_SMALL = 12.dp

    /** Gap between the card's stacked blocks — brand row, text, image, byline. */
    val BLOCK_SPACING = 8.dp

    /**
     * The byline's avatar. 28dp is below Material's 40dp list-avatar because the byline
     * is deliberately the least prominent thing on the card: it identifies the author
     * without inviting the reader to read the name before the post.
     *
     * That is also the mitigation for the one content risk on this surface. Post
     * content is filtered server-side (`DISCOVERY_SAFE_MATCH` in the discovery
     * sources), but an author's DISPLAY NAME is an identity field that no content
     * filter covers, and offensive ones exist in the real feed. Keeping the byline
     * small and secondary is a design answer to that; dropping such posts silently, or
     * inventing a name filter, is not.
     */
    val AVATAR_SIZE = 28.dp

    /** Gap between the avatar and the name it belongs to. */
    val BYLINE_SPACING = 8.dp

    /**
     * Corner radius on the image slot: the Material 3 Expressive shape scale's large
     * step. The CARD's own corner is not set here — `Scaffold` applies
     * `android.R.dimen.system_app_widget_background_radius`, the radius the launcher
     * itself clips widgets to, and a hand-set value inside that draws a second
     * mismatched curve just inside the first.
     */
    val IMAGE_CORNER_RADIUS = 20.dp

    /** One position pip, and the gap between two of them. */
    val PIP_SIZE = 6.dp
    val PIP_SPACING = 4.dp

    /**
     * The advance control's tap target: Material's 48dp minimum, the same floor every
     * tappable row and chip in this module already uses, and the size Glance's own
     * `CircleIconButton` draws at (`IconButtonShape.Circle` carries a 48dp default in
     * glance-appwidget 1.1.1). Passed to the button explicitly rather than left to that
     * default, because the byline's height and the 20dp each image slot gives up to make
     * room are both derived from this number.
     */
    val ADVANCE_CONTROL_SIZE = 48.dp

    /** The brand mark on the top row, at the same 20dp the app's own header uses. */
    val BRAND_MARK_SIZE = 20.dp

    /** Gap between the brand mark and the words beside it. */
    val BRAND_SPACING = 6.dp
}

/**
 * The image band's BASE height, per design — `null` where the design shows no picture.
 *
 * Base, not fixed: the band takes whatever height the card has left over, so this is the
 * height it has when there is NO slack, and it is what the bitmap is decoded for. It is a
 * BAND rather than the picture's own aspect ratio because a card whose height moved with
 * whatever photograph the rotation landed on would jump every fifteen minutes, and because
 * a portrait photo given its aspect ratio would push the text off a 180dp widget entirely.
 *
 * BOTH ARE 20dp SHORTER THAN THEY WERE, and that number is not a taste: it is exactly what
 * the byline row grows by when it carries the advance control
 * ([PostsCardDimensions.ADVANCE_CONTROL_SIZE] against the avatar's
 * [PostsCardDimensions.AVATAR_SIZE], which used to be the row's tallest thing). So the card
 * asks the launcher for the same total height it always did, and no placement that fitted
 * before can overflow now. The image pays rather than the text or the byline because the
 * image ILLUSTRATES the post while the control is what makes the widget work — and a card
 * nobody can advance was the defect being fixed. The band earns those 20dp back on any
 * placement with slack in it, which is most of them.
 */
internal fun imageSlotBaseHeight(size: PostsCardSize): Dp? = when (size) {
    // The small design has 110dp of height for a brand row, text and a byline. An
    // image would have about 20dp left, which is a stripe rather than a picture.
    PostsCardSize.SMALL -> null
    PostsCardSize.MEDIUM -> 52.dp
    PostsCardSize.LARGE -> 100.dp
}

/**
 * Whether this card carries the ADVANCE CONTROL — and therefore the position pips.
 *
 * ONE predicate for both, because the two disagreeing is the defect this fixes: pips on a
 * card with no way to advance read as a swipe affordance, and a widget cannot be swiped.
 * Wherever the dots appear, the control that moves them appears beside them.
 *
 * THE SMALL DESIGN GOES WITHOUT BOTH. At 250 × 110dp there are 86dp of content height for a
 * brand row, two lines of the post and a byline, which is already the tightest card this
 * widget draws; a 48dp control is more than half of it, and paying for it there would cost
 * the post text itself. "Small shows less" is the rule this module follows everywhere else,
 * and dropping the pips with the control is the honest half of it — a static card that says
 * nothing about a rotation promises nothing either. The rotation still turns over on the
 * refresh tick at every size.
 *
 * A rotation of ONE has nothing to advance to, so it gets neither, at any size.
 */
internal fun showsAdvanceControl(size: PostsCardSize, rotationLength: Int): Boolean =
    size != PostsCardSize.SMALL && rotationLength > 1

/**
 * Lines of text each design draws.
 *
 * Also the second guard on truncation: [truncateToBudget] cuts the string, and
 * `maxLines` catches the case where the character estimate ran low.
 */
internal fun textMaxLines(size: PostsCardSize): Int = when (size) {
    PostsCardSize.SMALL -> 2
    PostsCardSize.MEDIUM -> 3
    PostsCardSize.LARGE -> 5
}

/** Font size the post's text draws at, in sp. M3 Title Medium, up to Title Large. */
private fun textFontSizeSp(size: PostsCardSize): Float = when (size) {
    PostsCardSize.SMALL -> 15f
    PostsCardSize.MEDIUM -> 17f
    PostsCardSize.LARGE -> 20f
}

/**
 * Smallest font scale Android offers (Settings → Display → Font size).
 *
 * It is here because the character budget is INVERSELY proportional to the scale: a
 * reader on the smallest setting fits more characters on a line than one on the
 * default, so this is the setting at which the largest budget of all is reached, and
 * therefore the one that decides how much text is worth storing.
 */
private const val MIN_SYSTEM_FONT_SCALE = 0.85f

/**
 * How many characters of post text this design can show.
 *
 * An ESTIMATE, and it has to be: Glance emits `RemoteViews`, which the launcher
 * measures in its own process long after this code has run, so there is no way to ask
 * how wide a string is. [AVERAGE_GLYPH_WIDTH_RATIO] is the module's one calibrated
 * glyph metric (Roboto's advances cluster around 0.55em; 0.6 errs generous) and is
 * imported rather than restated so the two widget families cannot drift apart on it.
 *
 * Erring GENEROUS is the safe direction here, unlike in a chip cloud: over-estimating
 * hands the `TextView` a few more characters than fit and its own `maxLines` clips
 * them, while under-estimating cuts a sentence short with an ellipsis the reader can
 * see. Both are truncation; only one of them throws away room that was available.
 */
internal fun textBudgetChars(
    size: PostsCardSize,
    availableWidthDp: Float,
    fontScale: Float,
): Int {
    val effectiveScale = if (fontScale > 0f) fontScale else 1f
    val glyphWidthDp = textFontSizeSp(size) * effectiveScale * AVERAGE_GLYPH_WIDTH_RATIO
    if (glyphWidthDp <= 0f || availableWidthDp <= 0f) return 0
    val charsPerLine = availableWidthDp / glyphWidthDp
    return (charsPerLine * textMaxLines(size)).toInt().coerceAtLeast(0)
}

/**
 * The largest budget any design can reach, at the widest placement the widget allows
 * and the smallest font scale Android offers.
 *
 * Derived from the breakpoint table above rather than written down, so it cannot fall
 * out of step with it — which matters because [MAX_STORED_TEXT_CHARS] is this number,
 * and a store that held less than a card can draw would truncate text that had room.
 */
internal val LARGEST_TEXT_BUDGET_CHARS: Int = PostsCardSize.entries.maxOf { size ->
    val padding = if (size == PostsCardSize.SMALL) {
        PostsCardDimensions.PADDING_SMALL
    } else {
        PostsCardDimensions.PADDING
    }
    textBudgetChars(
        size = size,
        availableWidthDp = LARGE_MIN_WIDTH.value - padding.value * 2,
        fontScale = MIN_SYSTEM_FONT_SCALE,
    )
}

/** Appended to text that had to be cut. The single glyph, not three periods. */
private const val ELLIPSIS = "…"

/**
 * [text] cut to fit [budget] characters, at a word boundary where there is one.
 *
 * The cut is made at the last space inside the budget so a card never ends mid-word,
 * unless that would throw away more than [MIN_WORD_BOUNDARY_FRACTION] of the budget —
 * one very long token (a URL, a German compound) would otherwise cut the text back to
 * almost nothing. In that case it cuts mid-word instead, which is the lesser damage.
 *
 * Returns [text] untouched when it fits, so no card carries an ellipsis it did not
 * earn.
 */
internal fun truncateToBudget(text: String, budget: Int): String {
    if (budget <= 0) return ""
    if (text.length <= budget) return text

    // Room for the ellipsis itself, so the result is never longer than the budget.
    val cut = (budget - ELLIPSIS.length).coerceAtLeast(0)
    if (cut == 0) return ELLIPSIS

    val head = text.take(cut)
    val lastSpace = head.lastIndexOf(' ')
    val body = if (lastSpace >= cut * MIN_WORD_BOUNDARY_FRACTION) {
        head.substring(0, lastSpace)
    } else {
        head
    }
    return body.trimEnd() + ELLIPSIS
}

/**
 * How far back a word boundary may pull the cut, as a fraction of the budget.
 *
 * Half: a boundary in the second half of the text is worth honouring, one in the first
 * half means the budget was spent on a single token and cutting there would lose more
 * than the ragged edge is worth.
 */
private const val MIN_WORD_BOUNDARY_FRACTION = 0.5f

/**
 * The type scale, as Material 3 roles.
 *
 * Colour is a parameter rather than baked in because the card is a tonal container and
 * its text sits on `onPrimaryContainer`, while the image slot's own fallback sits on a
 * different pair.
 */
internal object PostsCardTextStyles {
    /** The brand row: M3 Label Medium, Medium weight. */
    fun brand(color: ColorProvider) = TextStyle(
        color = color,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
    )

    /**
     * The post itself — the emphasised element on the card, and the reason Material 3
     * Expressive is legible on a surface that cannot animate: emphasis here is type
     * size and weight, not motion or a morphing shape.
     */
    fun body(color: ColorProvider, size: PostsCardSize) = TextStyle(
        color = color,
        fontWeight = FontWeight.Medium,
        fontSize = textFontSizeSp(size).sp,
    )

    /** The byline's name: M3 Label Large. */
    fun bylineName(color: ColorProvider) = TextStyle(
        color = color,
        fontWeight = FontWeight.Medium,
        fontSize = 13.sp,
    )

    /** The byline's handle: M3 Label Medium, regular weight — quieter than the name. */
    fun bylineHandle(color: ColorProvider) = TextStyle(
        color = color,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
    )

    /** The first-run message; M3 Title Medium, as Glance's own `NoDataContent` uses. */
    fun emptyMessage(color: ColorProvider) = TextStyle(
        color = color,
        fontWeight = FontWeight.Medium,
        fontSize = 16.sp,
    )
}
