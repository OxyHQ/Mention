package earth.mention.widgets.posts

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.text.FontWeight
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import earth.mention.widgets.trends.AVERAGE_GLYPH_WIDTH_RATIO
import kotlin.math.ceil

/**
 * The trending-posts card's MEASUREMENTS and its BREAKPOINTS.
 *
 * Everything in this file is decided without a `Context`, a `Canvas` or a composition,
 * which is the point: the per-breakpoint decisions are the ones that can be wrong in a
 * way nobody notices until a widget is resized on a real home screen, so they are
 * written as pure functions and unit tested.
 *
 * The card is DESIGNED PER SIZE rather than stretched. Three designs, and each one drops
 * something rather than squeezing everything:
 *
 *   under 180dp tall          SMALL   brand row, two lines of text, byline. NO picture.
 *   180dp tall                MEDIUM  the same, plus the handle, the rotation controls,
 *                                     and a picture in whatever room is left.
 *   320 × 320dp and larger    LARGE   more lines of text, and the same derived picture.
 *
 * WHAT EACH DESIGN SHOWS is a breakpoint decision; HOW TALL THE PICTURE IS is not. The
 * slot takes the height the rest of the card does not need ([imageSlotHeight]), so a
 * placement between two cell counts spends the difference on the photograph instead of
 * leaving it blank. That is only possible because the widget composes at its REAL size
 * (`SizeMode.Exact`, see `PostsWidget`) rather than at the nearest declared bucket.
 *
 * The payload still has to be bounded, and with no declared size set it is bounded by
 * the per-bitmap pixel ceilings rather than by a table: see
 * [POSTS_WORST_CASE_BITMAP_BYTES].
 */

/** Which of the three designs a given placement gets. */
internal enum class PostsCardSize {
    SMALL,
    MEDIUM,
    LARGE,
}

/**
 * The largest placement the PROVIDER asks for, mirroring
 * `mention_posts_widget_max_resize_width` / `_max_resize_height` in `dimens_posts.xml`.
 *
 * A REQUEST, not a bound, and the difference matters to everything measured against it:
 * `maxResize*` limits how far a user may DRAG the widget, but the launcher still hands
 * out whole cells, and a cell is wider than the declaration assumes — on a 480dpi phone
 * a four-cell placement measures 387dp against this 320dp ceiling. So nothing here may
 * rely on it as a maximum; the payload is bounded by the per-bitmap pixel ceilings in
 * `PostsBitmapBudget.kt`, which hold at any size a launcher can invent.
 */
internal val POSTS_MAX_PLACEMENT: DpSize = DpSize(320.dp, 460.dp)

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

    /**
     * Shortest band still worth drawing a photograph in: twice [IMAGE_CORNER_RADIUS].
     *
     * Derived rather than chosen. Below twice the radius the two 20dp corners meet and
     * the slot has no straight edge left, so the picture reads as a lozenge rather than
     * as a photograph. A card with less room than this shows no picture at all — the
     * same answer the small design gives, for the same reason.
     */
    val MIN_IMAGE_HEIGHT = IMAGE_CORNER_RADIUS * 2

    /** One position pip, and the gap between two of them. */
    val PIP_SIZE = 6.dp
    val PIP_SPACING = 4.dp

    /**
     * The rotation controls' tap target.
     *
     * 48dp is Material's minimum touch target and the figure this module's design committed
     * to, so it is not negotiated down to fit — the control is dropped instead at the size
     * where it does not fit (see `RotationControlRow`). A widget is operated with a thumb over
     * a launcher that also interprets long-press and drag on the same pixels; a target that
     * is merely usually-hittable there costs the user a rearranged home screen.
     */
    val CONTROL_SIZE = 48.dp

    /** The brand mark on the top row, at the same 20dp the app's own header uses. */
    val BRAND_MARK_SIZE = 20.dp

    /** Gap between the brand mark and the words beside it. */
    val BRAND_SPACING = 6.dp
}

/** Padding inside a card of this design. */
internal fun cardPadding(size: PostsCardSize): Dp = if (size == PostsCardSize.SMALL) {
    PostsCardDimensions.PADDING_SMALL
} else {
    PostsCardDimensions.PADDING
}

/**
 * Whether the card draws the rotation's own control row.
 *
 * One predicate rather than a condition repeated in two places, because the LAYOUT and the
 * height arithmetic have to agree about it exactly: a card that reserved 48dp the layout
 * then declined to draw would leave a gap, and one that drew a row it had not reserved
 * would push the bottom of the card past the widget (a `RemoteViews` row is a
 * `LinearLayout` measured in the launcher's process, which clips rather than shrinks).
 *
 * A rotation of one has nowhere to step to, and the small design has no room for a 48dp
 * row — see `RotationControlRow` for both.
 */
internal fun showsRotationControls(size: PostsCardSize, rotationLength: Int): Boolean =
    rotationLength > 1 && size != PostsCardSize.SMALL

/**
 * Height of the picture: WHATEVER THE REST OF THE CARD DOES NOT NEED, or `null` when
 * that is not enough to draw a photograph in.
 *
 * The slot is still a BOUNDED BAND whose height is known before the bitmap is decoded —
 * that has not changed and cannot: `PostsImageRenderer.decodeCropped` crops to the slot's
 * exact aspect ratio and the picture is then drawn with `ContentScale.FillBounds`, so a
 * slot of unknown height (a Glance `defaultWeight`, say) would distort the photograph
 * rather than merely mis-size it. Nor does the slot take the image's OWN aspect ratio: a
 * portrait photograph given its natural shape would push the text off the card, and the
 * card's proportions would jump with whatever picture the rotation landed on.
 *
 * What changed is where the band's height COMES FROM. It used to be a constant per design
 * — 72dp and 120dp — which wasted every dp between one cell count and the next, and
 * over-committed the card when the text ran long. Now it is the height left after the
 * parts whose heights are known: the padding, the brand row, the text at the number of
 * lines the card will actually draw, the byline, the rotation controls, and the gap above
 * the picture. See [cardHeightWithoutImage].
 *
 * [textLines] is the line count the layout has COMMITTED to (`maxLines` on the `Text`),
 * not a guess about the string — the two are the same number by construction, which is
 * what makes this reservation exact instead of hopeful.
 */
internal fun imageSlotHeight(
    size: PostsCardSize,
    widgetHeight: Dp,
    textLines: Int,
    showsRotationControls: Boolean,
    fontScale: Float,
): Dp? {
    // The small design gives the picture up, not because the arithmetic says so but
    // because that is what it IS: the design that keeps a brand row, two lines and a
    // byline when there is nothing else to give.
    if (size == PostsCardSize.SMALL) return null

    val available = widgetHeight -
        cardHeightWithoutImage(size, textLines, showsRotationControls, fontScale)
    return if (available >= PostsCardDimensions.MIN_IMAGE_HEIGHT) available else null
}

/**
 * Everything on the card except the picture, added up — the reservation
 * [imageSlotHeight] subtracts.
 *
 * Every term is one of the constants above rather than a measurement, which is exactly
 * why it can be computed here, before the composition: a `Row` of a 20dp brand mark is
 * 20dp tall wherever it is drawn. The one estimated term is TEXT, and it is estimated in
 * the direction that cannot overflow (see [textBlockHeight]).
 *
 * The gap above the picture is charged here even when the post has no picture. That is
 * the direction that stays honest: the alternative is a slot that only fits because the
 * gap it sits under was not counted.
 */
internal fun cardHeightWithoutImage(
    size: PostsCardSize,
    textLines: Int,
    showsRotationControls: Boolean,
    fontScale: Float,
): Dp {
    val brandRow = maxOf(
        PostsCardDimensions.BRAND_MARK_SIZE,
        textBlockHeight(BRAND_FONT_SIZE_SP, lines = 1, fontScale = fontScale),
    )
    val text = if (textLines > 0) {
        PostsCardDimensions.BLOCK_SPACING +
            textBlockHeight(textFontSizeSp(size), textLines, fontScale)
    } else {
        0.dp
    }
    // The avatar is the tallest thing in the byline until the reader's font scale makes
    // the name taller than it.
    val byline = PostsCardDimensions.BLOCK_SPACING + maxOf(
        PostsCardDimensions.AVATAR_SIZE,
        textBlockHeight(BYLINE_NAME_FONT_SIZE_SP, lines = 1, fontScale = fontScale),
    )
    val controls = if (showsRotationControls) PostsCardDimensions.CONTROL_SIZE else 0.dp

    return cardPadding(size) * 2 + brandRow + text +
        PostsCardDimensions.BLOCK_SPACING + byline + controls
}

/**
 * Height a `TextView` of [lines] lines at [fontSizeSp] occupies.
 *
 * MEASURED rather than assumed, on the real widget at 480dpi: the card's 20sp body drew
 * 50.7dp at two lines and 74.3dp at three, and its 12sp label 16.3dp at one. That is
 * 1.164em per line plus 0.196em of font padding charged once — Roboto's metrics plus the
 * `includeFontPadding` a `TextView` adds by default and `RemoteViews` gives no way to
 * turn off. The ratios below round both UP, so the reservation is never short.
 *
 * Rounding up is the safe direction here, unlike in the character budget: this figure is
 * SUBTRACTED from the widget's height, so over-estimating costs the picture a few dp
 * while under-estimating pushes the bottom of the card past the widget, where the
 * launcher clips it.
 *
 * [fontScale] multiplies rather than being ignored: `sp` is scaled by the reader's
 * font-size setting and `dp` is not, so a card at a 1.3 scale spends a third more of its
 * height on the same words.
 */
private fun textBlockHeight(fontSizeSp: Float, lines: Int, fontScale: Float): Dp {
    if (lines <= 0) return 0.dp
    val effectiveScale = if (fontScale > 0f) fontScale else 1f
    val ems = TEXT_LINE_HEIGHT_RATIO * lines + TEXT_FONT_PADDING_RATIO
    return (fontSizeSp * effectiveScale * ems).dp
}

/** Height of one line of text, and the font padding a `TextView` adds once, in em. */
private const val TEXT_LINE_HEIGHT_RATIO = 1.2f
private const val TEXT_FONT_PADDING_RATIO = 0.2f

/**
 * Most lines of text each design will draw.
 *
 * A CEILING, not the count: the card commits to [textLinesFor], which is this bounded by
 * how much text there actually is, so a short post leaves its unused lines to the
 * picture instead of holding space it will not fill.
 */
internal fun textMaxLines(size: PostsCardSize): Int = when (size) {
    PostsCardSize.SMALL -> 2
    PostsCardSize.MEDIUM -> 3
    PostsCardSize.LARGE -> 5
}

/**
 * Lines the card commits to for a post of [textLength] characters — what the `Text` is
 * given as `maxLines` AND what [cardHeightWithoutImage] reserves, which is the whole
 * point of it being one function.
 *
 * Estimated from [charsPerLine], with the same caveat as the character budget: `RemoteViews`
 * is measured in the launcher's process, so there is no way to ask how many lines a string
 * takes. The estimate errs towards MORE lines than the text needs, because [charsPerLine]
 * assumes a wider glyph than Roboto actually draws — the measured card fitted 36 characters
 * on a line the estimate gave 29. Erring that way costs the picture a line's worth of
 * height; erring the other way would clip the card.
 *
 * Zero for a post with no words, which is a real post in this feed (a bare URL with a
 * picture) and the case the extra room is most worth having.
 */
internal fun textLinesFor(
    size: PostsCardSize,
    textLength: Int,
    availableWidthDp: Float,
    fontScale: Float,
): Int {
    if (textLength <= 0) return 0
    val perLine = charsPerLine(size, availableWidthDp, fontScale)
    if (perLine <= 0f) return 0
    return ceil(textLength / perLine).toInt().coerceIn(1, textMaxLines(size))
}

/** Font size the post's text draws at, in sp. M3 Title Medium, up to Title Large. */
private fun textFontSizeSp(size: PostsCardSize): Float = when (size) {
    PostsCardSize.SMALL -> 15f
    PostsCardSize.MEDIUM -> 17f
    PostsCardSize.LARGE -> 20f
}

/** The brand row's label, and the byline's name — the two the height arithmetic reads. */
private const val BRAND_FONT_SIZE_SP = 12f
private const val BYLINE_NAME_FONT_SIZE_SP = 13f

/** The byline's handle, quieter than the name beside it. */
private const val BYLINE_HANDLE_FONT_SIZE_SP = 12f

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
): Int = (charsPerLine(size, availableWidthDp, fontScale) * textMaxLines(size))
    .toInt()
    .coerceAtLeast(0)

/**
 * Characters that fit on ONE line of this design, at this width.
 *
 * The estimate both [textBudgetChars] and [textLinesFor] are built from, so the budget
 * and the line count can never disagree about how wide a character is. Zero for a
 * degenerate width or font size, which the callers treat as "no text".
 */
private fun charsPerLine(
    size: PostsCardSize,
    availableWidthDp: Float,
    fontScale: Float,
): Float {
    val effectiveScale = if (fontScale > 0f) fontScale else 1f
    val glyphWidthDp = textFontSizeSp(size) * effectiveScale * AVERAGE_GLYPH_WIDTH_RATIO
    if (glyphWidthDp <= 0f || availableWidthDp <= 0f) return 0f
    return availableWidthDp / glyphWidthDp
}

/**
 * The largest budget any design can reach at the widest placement the provider asks for
 * ([POSTS_MAX_PLACEMENT]) and the smallest font scale Android offers.
 *
 * Derived from the breakpoint table above rather than written down, so it cannot fall
 * out of step with it — which matters because [MAX_STORED_TEXT_CHARS] is this number,
 * and a store that held less than a card can draw would truncate text that had room.
 *
 * A launcher may hand over a card WIDER than that ceiling, since it deals in whole cells
 * (387dp for four of them at 480dpi). Such a card fits a few more characters than the
 * store keeps, so it draws all of the stored text with no ellipsis — never less than it
 * stored, which is the direction that costs the reader nothing visible.
 */
internal val LARGEST_TEXT_BUDGET_CHARS: Int = PostsCardSize.entries.maxOf { size ->
    textBudgetChars(
        size = size,
        availableWidthDp = POSTS_MAX_PLACEMENT.width.value - cardPadding(size).value * 2,
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
        fontSize = BRAND_FONT_SIZE_SP.sp,
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
        fontSize = BYLINE_NAME_FONT_SIZE_SP.sp,
    )

    /** The byline's handle: M3 Label Medium, regular weight — quieter than the name. */
    fun bylineHandle(color: ColorProvider) = TextStyle(
        color = color,
        fontWeight = FontWeight.Normal,
        fontSize = BYLINE_HANDLE_FONT_SIZE_SP.sp,
    )

    /** The first-run message; M3 Title Medium, as Glance's own `NoDataContent` uses. */
    fun emptyMessage(color: ColorProvider) = TextStyle(
        color = color,
        fontWeight = FontWeight.Medium,
        fontSize = 16.sp,
    )
}
