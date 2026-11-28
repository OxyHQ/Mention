package earth.mention.widgets.trends

import androidx.compose.ui.unit.dp
import earth.mention.widgets.trends.card.cardSecondaryNamesThatFit
import earth.mention.widgets.trends.chips.TrendsChipDimensions
import earth.mention.widgets.trends.chips.estimateChipWidthDp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What each widget shows at each size.
 *
 * This is the file that answers the complaint the three variants were built for: a
 * small widget must show LESS, not the same content squeezed. None of the counts
 * below is a table in the source — they are what `rowsThatFit` and `packRows` compute
 * from the cited dimensions — so these tests are where the intended behaviour of each
 * breakpoint is actually written down.
 *
 * The sizes are the ones the variants declare, each a whole number of launcher cells
 * (`70 × n − 30`): 110dp is 2, 180dp is 3, 250dp is 4, 320dp is 5.
 */
class TrendsBreakpointsTest {

    /** No title bar below three cells of height; the same rule for every variant. */
    private fun showTitleBar(heightDp: Int) =
        heightDp.dp >= TrendsWidgetDimensions.TITLE_BAR_MIN_HEIGHT

    private fun listRows(heightDp: Int) = rowsThatFit(
        widgetHeight = heightDp.dp,
        showTitleBar = showTitleBar(heightDp),
        rowHeight = TrendsWidgetDimensions.ROW_HEIGHT,
        rowSpacing = TrendsWidgetDimensions.ITEM_SPACING,
    )

    private fun chipRows(heightDp: Int) = rowsThatFit(
        widgetHeight = heightDp.dp,
        showTitleBar = showTitleBar(heightDp),
        rowHeight = TrendsChipDimensions.CHIP_HEIGHT,
        rowSpacing = TrendsChipDimensions.CHIP_SPACING,
    )

    @Test
    fun `the ranked list shows one row at both short sizes, which is what turns it into a headline`() {
        // 2×2 and 4×2. One 48dp row is all 110dp of height can hold once padding is
        // taken, so the list stops being a list here and leads with one trend
        // instead — the whole point of the variant's small-size behaviour.
        assertEquals(1, listRows(110))
    }

    @Test
    fun `the ranked list grows a row per cell of height`() {
        assertEquals(2, listRows(180))
        assertEquals(3, listRows(250))
        assertEquals(4, listRows(320))
    }

    @Test
    fun `every extra row costs a whole touch target, never half of one`() {
        // A row is 48dp because that is Material's minimum tap target, and dividing
        // the widget by that pitch is what stops a breakpoint ever producing a row
        // too short to press.
        val heights = listOf(110, 180, 250, 320)
        heights.zipWithNext().forEach { (shorter, taller) ->
            assertTrue(
                "$shorter gave ${listRows(shorter)}, $taller gave ${listRows(taller)}",
                listRows(taller) > listRows(shorter),
            )
        }
    }

    @Test
    fun `the chip cloud shows fewer rows than the list at the same heights`() {
        // Chips are the same 48dp tap target with more air between them, so a given
        // height holds no more chip rows than list rows — a cloud that claimed
        // otherwise would be clipping its last row.
        listOf(110, 180, 250, 320).forEach { height ->
            assertTrue(
                "at ${height}dp: ${chipRows(height)} chip rows vs ${listRows(height)} list rows",
                chipRows(height) <= listRows(height),
            )
        }
        assertEquals(1, chipRows(110))
        assertEquals(2, chipRows(180))
        assertEquals(3, chipRows(250))
        assertEquals(4, chipRows(320))
    }

    @Test
    fun `a height no breakpoint declared still yields a sane row count`() {
        // A launcher may hand over anything; the count is derived, so it answers.
        assertEquals(1, listRows(60))
        assertEquals(1, listRows(0))
        assertTrue(listRows(1000) > 4)
    }

    @Test
    fun `a chip is wider when the trend carries a post count`() {
        val bare = estimateChipWidthDp("#tradeshow", count = "", fontScale = 1f)
        val counted = estimateChipWidthDp("#tradeshow", count = "11", fontScale = 1f)

        assertTrue("$bare vs $counted", counted > bare)
    }

    @Test
    fun `a large font setting widens every chip`() {
        val normal = estimateChipWidthDp("#tradeshow", count = "11", fontScale = 1f)
        val large = estimateChipWidthDp("#tradeshow", count = "11", fontScale = 1.3f)

        // Leaving fontScale out is what makes a widget look broken for readers who
        // need large text: the layout would keep assuming the small-text width.
        assertTrue("$normal at 1.0 vs $large at 1.3", large > normal)
    }

    @Test
    fun `the chip cloud packs real trends into the width it actually has`() {
        // Production's current batch, and the widths the chips estimate for it.
        val widths = listOf(
            "business" to "",
            "tech" to "",
            "gaming" to "",
            "ai" to "",
            "food" to "",
            "#tradeshow" to "11",
            "#event" to "11",
            "#show" to "11",
        ).map { (name, count) -> estimateChipWidthDp(name, count, fontScale = 1f) }

        // 250dp wide (4 cells) less the content's 12dp padding either side.
        val rows = packRows(
            widths = widths,
            availableWidthDp = 250f - TrendsWidgetDimensions.WIDGET_PADDING.value * 2,
            maxRows = 3,
            spacingDp = TrendsChipDimensions.CHIP_SPACING.value,
        )

        assertEquals(3, rows.size)
        // Ranked order is preserved across the whole cloud: a packer that reordered
        // trends to fill space better would be lying about which is trending hardest.
        assertEquals(
            (0 until rows.sumOf { it.size }).toList(),
            rows.flatten(),
        )
        // Every row is filled to the point where the next chip would not fit, so no
        // size leaves a half-empty row — the reason this variant exists.
        rows.dropLast(1).forEachIndexed { index, row ->
            val used = row.sumOf { widths[it].toDouble() } +
                TrendsChipDimensions.CHIP_SPACING.value * (row.size - 1)
            val nextChip = widths[rows[index + 1].first()]
            assertTrue(
                "row $index used $used and could still have taken $nextChip",
                used + TrendsChipDimensions.CHIP_SPACING.value + nextChip >
                    250f - TrendsWidgetDimensions.WIDGET_PADDING.value * 2,
            )
        }
    }

    @Test
    fun `a narrow widget packs fewer chips per row than a wide one`() {
        val widths = List(8) { estimateChipWidthDp("#tradeshow", "11", fontScale = 1f) }

        val narrow = packRows(widths, availableWidthDp = 86f, maxRows = 1, spacingDp = 6f)
        val wide = packRows(widths, availableWidthDp = 296f, maxRows = 1, spacingDp = 6f)

        assertTrue(
            "narrow ${narrow.first().size} vs wide ${wide.first().size}",
            wide.first().size > narrow.first().size,
        )
    }

    @Test
    fun `packing stops at the row limit and drops what is past it`() {
        val widths = List(20) { 100f }

        val rows = packRows(widths, availableWidthDp = 226f, maxRows = 2, spacingDp = 6f)

        assertEquals(2, rows.size)
        // Two per row at 100dp + 6dp spacing inside 226dp.
        assertEquals(listOf(0, 1), rows[0])
        assertEquals(listOf(2, 3), rows[1])
    }

    @Test
    fun `an item too wide for the row is placed alone rather than dropped`() {
        // Its text truncates, which is legible; dropping it would silently lose a
        // trend the server ranked.
        val rows = packRows(listOf(400f, 50f), availableWidthDp = 226f, maxRows = 2, spacingDp = 6f)

        assertEquals(listOf(listOf(0), listOf(1)), rows)
    }

    @Test
    fun `packing nothing into no space yields no rows`() {
        assertEquals(emptyList<List<Int>>(), packRows(listOf(50f), availableWidthDp = 0f, maxRows = 2, spacingDp = 6f))
        assertEquals(emptyList<List<Int>>(), packRows(listOf(50f), availableWidthDp = 226f, maxRows = 0, spacingDp = 6f))
        assertEquals(emptyList<List<Int>>(), packRows(emptyList(), availableWidthDp = 226f, maxRows = 2, spacingDp = 6f))
    }

    @Test
    fun `the cards secondary line takes as many names as the width allows`() {
        val names = listOf("tech", "gaming", "ai", "food", "#tradeshow", "#event")

        // 4 cells wide (250dp) less the card's 16dp padding either side.
        val wide = cardSecondaryNamesThatFit(names, availableWidthDp = 250f - 32f, fontScale = 1f)
        // 2 cells wide (110dp) less the compact 12dp padding either side.
        val narrow = cardSecondaryNamesThatFit(names, availableWidthDp = 110f - 24f, fontScale = 1f)

        assertTrue("wide fitted ${wide.size}", wide.size > narrow.size)
        assertTrue("narrow fitted ${narrow.size}", narrow.isNotEmpty())
        // One line only, and in rank order from the trend after the headline.
        assertEquals(wide.sorted(), wide)
        assertEquals(0, wide.first())
    }

    @Test
    fun `the cards secondary line shrinks when the reader uses large text`() {
        val names = listOf("tech", "gaming", "ai", "food", "#tradeshow", "#event")

        val normal = cardSecondaryNamesThatFit(names, availableWidthDp = 218f, fontScale = 1f)
        val large = cardSecondaryNamesThatFit(names, availableWidthDp = 218f, fontScale = 2f)

        assertTrue("${normal.size} at 1.0 vs ${large.size} at 2.0", large.size < normal.size)
    }

    @Test
    fun `a name estimate scales with its length`() {
        val short = estimateTextWidthDp("ai", 14f, 1f)
        val long = estimateTextWidthDp("#tradeshow", 14f, 1f)

        assertTrue("$short vs $long", long > short)
        assertEquals(2 * 14f * AVERAGE_GLYPH_WIDTH_RATIO, short, 0.001f)
    }
}
