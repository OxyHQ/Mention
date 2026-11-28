package earth.mention.widgets.trends

/**
 * Fitting a variable number of variable-width items onto a line, WITHOUT being able
 * to measure them.
 *
 * Glance has no flow layout and no measurement API: a composition emits
 * `RemoteViews`, which the launcher measures in its own process long after our code
 * has finished running. So a chip cloud or a run of names separated by dots cannot
 * be laid out by asking how wide the text is — the width has to be estimated before
 * anything is emitted.
 *
 * That estimate is a LEGIBILITY BUDGET, not a measurement, and the layouts are built
 * so that being wrong by a chip's worth costs nothing: [packRows] decides how many
 * items go on a line, and the line then stretches them to fill it. An estimate that
 * runs 15% high puts one fewer chip on a row; one that runs low puts one more and
 * each is a little narrower. Neither overflows, and neither leaves a gap.
 */

/**
 * Average glyph advance as a fraction of the font size.
 *
 * Roboto's lowercase advances cluster around 0.55em and its digits are 0.56em, so
 * 0.6 is deliberately a little generous: over-estimating costs one item on a line,
 * while under-estimating crowds text towards truncation, and truncation is the one
 * outcome a reader notices.
 *
 * It is an average over a mixed string, so it is least accurate for the extremes —
 * `#iiii` is over-estimated, `#WWWW` under-estimated. Trend names are ordinary words
 * and hashtags, which is the case it is calibrated for.
 */
internal const val AVERAGE_GLYPH_WIDTH_RATIO = 0.6f

/**
 * Roughly how wide [text] renders, in dp.
 *
 * [fontScale] is the user's font-size setting (`Configuration.fontScale`), and it is
 * in here because leaving it out is what makes a widget look broken for the readers
 * who need large text: at a 1.3 scale every label is a third wider than the layout
 * assumed. Android 14's non-linear scaling means large settings scale headline sizes
 * less than this assumes, which errs towards over-estimating — the safe direction.
 */
internal fun estimateTextWidthDp(text: String, fontSizeSp: Float, fontScale: Float): Float =
    text.length * fontSizeSp * fontScale * AVERAGE_GLYPH_WIDTH_RATIO

/**
 * Greedy first-fit: fill each row with as many items as fit, in order, and stop
 * after [maxRows] rows.
 *
 * Returns the item INDICES per row, so a caller can map back to whatever it is
 * drawing. Order is preserved throughout — these are ranked trends, and a packer
 * that reordered them to fill space better would be lying about which is trending
 * hardest.
 *
 * An item wider than the whole row is placed alone on its own row rather than
 * dropped: the layout gives it the full width and its text truncates, which is a
 * legible outcome, where dropping it would silently lose a trend.
 */
internal fun packRows(
    widths: List<Float>,
    availableWidthDp: Float,
    maxRows: Int,
    spacingDp: Float,
): List<List<Int>> {
    if (maxRows <= 0 || availableWidthDp <= 0f) return emptyList()

    val rows = mutableListOf<List<Int>>()
    var current = mutableListOf<Int>()
    var used = 0f

    for ((index, width) in widths.withIndex()) {
        if (current.isNotEmpty() && used + spacingDp + width > availableWidthDp) {
            rows += current
            if (rows.size >= maxRows) return rows
            current = mutableListOf()
            used = 0f
        }
        used += if (current.isEmpty()) width else spacingDp + width
        current += index
    }

    if (current.isNotEmpty()) rows += current
    return rows
}
