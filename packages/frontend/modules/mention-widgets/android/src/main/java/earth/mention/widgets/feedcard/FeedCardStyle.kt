package earth.mention.widgets.feedcard

import androidx.compose.ui.graphics.Color
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
 * The card is DESIGNED PER SIZE rather than stretched. Three designs, and each one drops
 * something rather than squeezing everything:
 *
 *   under 180dp tall          SMALL   brand row, text, byline. No handle.
 *   180dp tall                MEDIUM  the same, plus the author's handle.
 *   320 × 320dp and larger    LARGE   the same, at a larger type size.
 *
 * How many LINES of text each draws is no longer part of that table: it is derived from the
 * height the launcher actually gave the card (see [textMaxLines]), because a table sized for
 * a layout that reserved a media band promised the small card a line it had no room for and
 * denied the large one several it did.
 *
 * THE PICTURE IS NOT ONE OF THESE DECISIONS. It is the card's BACKGROUND — full-bleed
 * behind everything, at every size, so it costs no layout height and there is no slot to
 * measure. What the designs differ in is how many words fit on top of it.
 *
 * Two consequences of that, both handled here rather than in the layout:
 *
 *  - A photograph the app did not choose sits under the text, so legibility cannot come
 *    from a theme colour. Over a picture the text is [OVER_IMAGE_CONTENT_COLOR] on a
 *    baked scrim of [IMAGE_SCRIM_ALPHA]; a card with no picture keeps the tonal container
 *    and the theme's own `onPrimaryContainer`.
 *  - The bitmap is bounded by pixels rather than by the card, because it does not depend
 *    on the card's size at all: see [FEED_CARD_WORST_CASE_BITMAP_BYTES].
 */

/** Which of the three designs a given placement gets. */
internal enum class FeedCardSize {
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
 * a four-cell placement measures 387 × 325dp against this 320 × 320dp ceiling, measured.
 * So nothing may rely on it as a maximum. Nothing has to: the picture is sized from a
 * pixel budget that has no reference to the card at all (`FeedCardBitmaps.kt`), and the
 * only thing left that reads this constant is the text cap below.
 */
internal val FEED_CARD_MAX_PLACEMENT: DpSize = DpSize(320.dp, 320.dp)

/**
 * The placement the TEXT STORE is sized for — deliberately larger than any real one.
 *
 * Not a design size and never used to lay anything out. It exists because
 * [MAX_STORED_TEXT_CHARS] has to bound every card the launcher can produce, and the
 * launcher hands out whole cells: a four-cell placement measures 387 × 325dp on a 480dpi
 * phone, past the 320 × 320dp the provider requests. Sizing the store to the request would
 * leave the biggest real cards short of words, which is exactly the "the text gets cut"
 * this file's line arithmetic exists to prevent.
 *
 * 640 × 640dp is past any phone placement by a wide margin and past a tablet's too. The
 * first value tried, 480 × 480, was NOT enough: the test that probes real placements found
 * the small design wanting 1699 characters at 520 × 480 against a 1490-character store,
 * because the small design's 15sp type fits the most characters per line of the three. That
 * is the failure this constant exists to prevent, caught by widening the probe rather than
 * by a reader noticing a clipped sentence.
 *
 * It costs one integer. The extra characters live in a single preferences entry, and each
 * card cuts what it draws to its own budget anyway.
 */
private val TEXT_STORAGE_PLACEMENT: DpSize = DpSize(640.dp, 640.dp)

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
internal fun feedCardSize(width: Dp, height: Dp): FeedCardSize = when {
    height >= LARGE_MIN_HEIGHT && width >= LARGE_MIN_WIDTH -> FeedCardSize.LARGE
    height >= MEDIUM_MIN_HEIGHT -> FeedCardSize.MEDIUM
    else -> FeedCardSize.SMALL
}

internal object FeedCardDimensions {
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

    // There is deliberately NO corner-radius constant here any more, and none is baked into
    // the picture either. The picture is the card, so its corners ARE the card's corners, and
    // those are the host's to draw: `Scaffold` rounds its background with
    // `android.R.dimen.system_app_widget_background_radius` on API 31+, and the launcher clips
    // the widget's content to the same curve. Verified rather than assumed — on a real
    // launcher the pixel just inside the widget's bounding box but outside the card's arc is
    // wallpaper, at all four corners of two widgets whose background graphic runs to the edge.
    // A radius baked into the bitmap would draw a second, slightly different curve just inside
    // the host's. The AVATAR still rounds its own pixels (`FeedImageRenderer.decodeCircular`)
    // because a circle inside the card IS ours to draw, and Glance's `cornerRadius` modifier
    // does nothing below API 31.

    /** The brand mark on the top row, at the same 20dp the app's own header uses. */
    val BRAND_MARK_SIZE = 20.dp

    /** Gap between the brand mark and the words beside it. */
    val BRAND_SPACING = 6.dp
}

/** Padding inside a card of this design. */
internal fun cardPadding(size: FeedCardSize): Dp = if (size == FeedCardSize.SMALL) {
    FeedCardDimensions.PADDING_SMALL
} else {
    FeedCardDimensions.PADDING
}

/**
 * How much black is baked over the picture before any text is drawn on it — 55%.
 *
 * DERIVED FROM A CONTRAST FLOOR, not chosen by eye, because the picture is arbitrary: the
 * explore feed can and does supply a photograph that is white where the byline sits. Take
 * the worst case the feed can produce — a pure white pixel — put `a` of black over it, and
 * white text on the result has a WCAG contrast ratio of `1.05 / (L + 0.05)` where `L` is
 * the sRGB-linearised luminance of `1 − a`. At 0.50 that is 3.98:1, which clears AA for
 * large text only; at 0.55 it is 4.75:1, which clears the 4.5:1 AA floor for text of ANY
 * size — and the smallest type on this card is a 12sp handle.
 *
 * ## Why a flat scrim rather than the usual gradient
 *
 * A vertical gradient, strongest where the text sits, is the standard treatment and it is
 * the WRONG one here — not for taste, but because the bitmap is not in one-to-one
 * correspondence with the card. The picture is sized independently of the placement and
 * the launcher CENTRE-CROPS it to whatever the card turns out to be (see
 * [cardBackgroundBitmapSize]), so on a wide card the launcher throws away the top and
 * bottom of the bitmap — exactly the bands a gradient would have put its protection in.
 * A flat scrim survives any crop, so the contrast floor above holds at every placement
 * instead of at the ones the gradient was drawn for.
 */
internal const val IMAGE_SCRIM_ALPHA = 0.55f

/**
 * The text colour over a picture: plain white, and DELIBERATELY NOT A THEME COLOUR.
 *
 * Everywhere else this module takes its colours from `GlanceTheme`, which on API 31+
 * follows the user's wallpaper — and that is exactly why it cannot be used here. Material
 * You is free to hand this card a light `onPrimaryContainer`, which is correct on the
 * tonal container it was picked for and unreadable over a photograph. The pairing that
 * makes the card legible is a fixed light foreground on [IMAGE_SCRIM_ALPHA], and the
 * contrast figure quoted there is computed for white specifically.
 *
 * So this is a considered exception to the dynamic-colour rule, for the one surface where
 * the background is not ours to choose. A card with NO picture keeps the theme colour —
 * see `FeedCardContent`. Please do not "fix" this back.
 */
internal val OVER_IMAGE_CONTENT_COLOR: ColorProvider = ColorProvider(Color.White)

/**
 * Roboto's line box as a multiple of its font size.
 *
 * 1.2 is the platform default for a `TextView` with no explicit line spacing, which is
 * what Glance emits. Used only to convert a font size into the height one line occupies.
 */
private const val LINE_HEIGHT_RATIO = 1.2f

/**
 * Height the HOST keeps for itself, which `LocalSize` does not tell us about.
 *
 * MEASURED, because there is no API that reports it: on a real launcher the byline's 28dp
 * avatar came out 83 x 73 device pixels at density 3 — 27.7 x 24.3dp. Square bitmap, square
 * `size()` modifier, and still 4dp shorter than it asked for, which means the column had
 * less room than `LocalSize.height` and clipped its last child. The avatar sliced flat along
 * the bottom is exactly that clip, and the card's own background shows below the cut, which
 * is how it is distinguishable from a bitmap that was decoded wrong.
 *
 * 8dp rather than the 4 observed: the measurement is one launcher at one density, the
 * `TextView`'s `includeFontPadding` adds a little more on top of its line boxes, and the cost
 * of over-reserving is a few pixels of slack while the cost of under-reserving is a clipped
 * avatar. It is subtracted once, in [usableCardHeightDp], so every derivation in this file
 * shares one answer rather than each guessing.
 */
private const val HOST_CONTENT_INSET_DP = 8f

/** The height the card can actually lay out in, as opposed to the one it was told. */
private fun usableCardHeightDp(cardHeight: Dp): Float = cardHeight.value - HOST_CONTENT_INSET_DP

/**
 * Average glyph advance for the card's BODY text, as a fraction of the font size.
 *
 * The module's shared [AVERAGE_GLYPH_WIDTH_RATIO] is 0.6, and it is right where it is used —
 * packing chips into a row, where over-estimating how many characters fit makes a chip
 * overflow its cloud. Here the incentive is exactly reversed: `maxLines` is the real bound,
 * the `TextView` clips anything past it for free, and a budget that runs SHORT ends a
 * sentence with a visible ellipsis while the room it needed sits empty.
 *
 * MEASURED, not taken from the type spec. On a real launcher 31 characters of body text
 * occupy 218dp at 17sp, which is an advance of 0.41em. Roboto's lowercase advances are often
 * quoted near 0.5em, and 0.5 was tried first — it still allowed only 25 characters where 31
 * were observed, because prose is not lowercase letters: spaces, `i`, `l`, `t` and
 * punctuation pull the running average well below the nominal figure.
 *
 * So this is the observation itself, and erring at or slightly below it is the safe side
 * here: a budget that runs long costs nothing (the `TextView` clips at `maxLines`), while one
 * that runs short ends a sentence with a visible ellipsis and leaves the room it needed
 * empty. A test pins it against that measurement, so raising it silently would fail.
 */
private const val BODY_GLYPH_WIDTH_RATIO = 0.41f

/**
 * Lines of text this card can actually show, DERIVED from the height it was given.
 *
 * It used to be a table — 2, 3, 5 by design — and that table was calibrated when the
 * picture took a fixed BAND of vertical space in the middle of the card. The picture is
 * now the background, so the band is gone and the room it held belongs to the words. A
 * table sized for the old layout kept the text at its old length and clipped the rest,
 * which is the "the text gets cut" the user reported.
 *
 * Deriving it also fixes the opposite error at the smallest size, which is the same bug
 * wearing the other face: 110dp of height minus padding, a brand row and a byline leaves
 * roughly one line, and the table claimed two — so the `TextView` was handed a second
 * line it had nowhere to draw and clipped it. A derived count cannot promise a line that
 * does not fit.
 *
 * The chrome subtracted is every block that is always present and whose height is known:
 * padding top and bottom, the brand row (its mark is the tallest thing in it), the gaps
 * either side of the text, and the byline (its avatar likewise). The media is NOT
 * subtracted — that is the whole point of it being the background now.
 *
 * [fontScale] matters in both directions: a reader at 1.3 gets taller lines and therefore
 * fewer of them, which is the honest answer rather than a clipped one.
 *
 * Still the second guard on truncation: [truncateToBudget] cuts the string against a width
 * estimate, and `maxLines` bounds what happens if that estimate ran low.
 */
internal fun textMaxLines(size: FeedCardSize, cardHeight: Dp, fontScale: Float): Int {
    val lineHeightDp = bodyLineHeightDp(size, fontScale)
    if (lineHeightDp <= 0f) return 0
    val available = usableCardHeightDp(cardHeight) - chromeHeightDp(size, showsBrandRow(size, cardHeight, fontScale))
    if (available < lineHeightDp) return 0
    return (available / lineHeightDp).toInt()
}

/**
 * Exact height the text block occupies for [lines] lines.
 *
 * The block is given this height EXPLICITLY rather than a layout weight, and that is the
 * fix for a real defect: with a weight, the `TextView`'s own measured height competes with
 * the space the column has left, and when the two disagree the launcher resolves it by
 * pushing the byline down — which reads as the avatar and handle sitting on top of the
 * text at the smallest sizes. Give every child a height the arithmetic already knows and
 * the sum cannot exceed the card, so nothing can be pushed anywhere.
 *
 * The words still get the room: [lines] is derived from the height available, so this IS
 * the leftover space, just spent deterministically instead of negotiated at layout time.
 */
internal fun textBlockHeightDp(size: FeedCardSize, fontScale: Float, lines: Int): Float =
    if (lines <= 0) 0f else bodyLineHeightDp(size, fontScale) * lines

/** Height of one line of body text at this design and font scale. */
private fun bodyLineHeightDp(size: FeedCardSize, fontScale: Float): Float {
    val effectiveScale = if (fontScale > 0f) fontScale else 1f
    return textFontSizeSp(size) * effectiveScale * LINE_HEIGHT_RATIO
}

/**
 * Everything that is not the text: padding, the byline, and the brand row when it is drawn.
 *
 * The gaps are counted with the blocks they separate — one below the brand row when it is
 * there, and always one above the byline.
 */
private fun chromeHeightDp(size: FeedCardSize, withBrandRow: Boolean): Float {
    val padding = cardPadding(size).value * 2
    val byline = FeedCardDimensions.AVATAR_SIZE.value + FeedCardDimensions.BLOCK_SPACING.value
    val brand = if (withBrandRow) {
        FeedCardDimensions.BRAND_MARK_SIZE.value + FeedCardDimensions.BLOCK_SPACING.value
    } else {
        0f
    }
    return padding + byline + brand
}

/**
 * Whether the card is tall enough to spend 28dp on saying which feed this came from.
 *
 * The brand row is the FIRST thing dropped as the card shrinks, and it is the right one to
 * drop: its own doc calls it the quietest thing on the card, context for the post rather
 * than a headline. The byline is not a candidate — a card whose byline cannot name anyone is
 * a card that could be attributed to anyone, which is a content-safety property rather than
 * a layout preference.
 *
 * Dropped only when keeping it would cost the last line of TEXT, so a card that can afford
 * both keeps both. At the 72dp floor neither survives: the byline and padding alone leave
 * 20dp, less than one 18dp line, so the card is a picture with an attribution — and that is
 * the honest answer at two launcher cells by one, rather than a line sliced through the
 * middle, which is what the previous `coerceAtLeast(1)` produced.
 */
internal fun showsBrandRow(size: FeedCardSize, cardHeight: Dp, fontScale: Float): Boolean {
    val lineHeightDp = bodyLineHeightDp(size, fontScale)
    if (lineHeightDp <= 0f) return true
    return usableCardHeightDp(cardHeight) - chromeHeightDp(size, withBrandRow = true) >= lineHeightDp
}

/** Font size the post's text draws at, in sp. M3 Title Medium, up to Title Large. */
private fun textFontSizeSp(size: FeedCardSize): Float = when (size) {
    FeedCardSize.SMALL -> 15f
    FeedCardSize.MEDIUM -> 17f
    FeedCardSize.LARGE -> 20f
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
    size: FeedCardSize,
    availableWidthDp: Float,
    cardHeight: Dp,
    fontScale: Float,
): Int {
    val effectiveScale = if (fontScale > 0f) fontScale else 1f
    val glyphWidthDp = textFontSizeSp(size) * effectiveScale * BODY_GLYPH_WIDTH_RATIO
    if (glyphWidthDp <= 0f || availableWidthDp <= 0f) return 0
    val charsPerLine = availableWidthDp / glyphWidthDp
    return (charsPerLine * textMaxLines(size, cardHeight, effectiveScale)).toInt().coerceAtLeast(0)
}

/**
 * The largest budget any design can reach at the widest placement the provider asks for
 * ([FEED_CARD_MAX_PLACEMENT]) and the smallest font scale Android offers.
 *
 * Derived from the breakpoint table above rather than written down, so it cannot fall
 * out of step with it — which matters because [MAX_STORED_TEXT_CHARS] is this number,
 * and a store that held less than a card can draw would truncate text that had room.
 *
 * A launcher may hand over a card LARGER than that ceiling, since it deals in whole cells
 * — 387 × 325dp for four of them at 480dpi, measured. That used to cost only a few
 * characters of width, and the argument was that a card simply drew all of the stored text
 * with no ellipsis. It no longer holds: now that the line count is derived from HEIGHT, a
 * card 5dp taller than the ceiling is not a few characters richer, it is a whole line
 * richer, and a store sized to the declared ceiling would run out of words to give it.
 *
 * So the cap is computed against [TEXT_STORAGE_PLACEMENT] — a placement chosen to exceed
 * any the launcher can actually produce — rather than against what the provider asks for.
 * Over-storing is free: the text lives in one preferences entry and is cut to the drawn
 * card's own budget at composition. Under-storing is what the reader sees as a sentence
 * ending early.
 */
internal val LARGEST_TEXT_BUDGET_CHARS: Int = FeedCardSize.entries.maxOf { size ->
    textBudgetChars(
        size = size,
        availableWidthDp = TEXT_STORAGE_PLACEMENT.width.value - cardPadding(size).value * 2,
        cardHeight = TEXT_STORAGE_PLACEMENT.height,
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
internal object FeedCardTextStyles {
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
    fun body(color: ColorProvider, size: FeedCardSize) = TextStyle(
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
