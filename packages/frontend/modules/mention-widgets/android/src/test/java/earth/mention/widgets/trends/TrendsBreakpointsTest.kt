package earth.mention.widgets.trends

<<<<<<< HEAD
import androidx.compose.ui.unit.dp
import earth.mention.widgets.trends.card.cardSecondaryNamesThatFit
import earth.mention.widgets.trends.chips.TrendsChipDimensions
import earth.mention.widgets.trends.chips.estimateChipWidthDp
import org.junit.Assert.assertEquals
=======
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import earth.mention.widgets.sparkline.sparklineBandHeight
import earth.mention.widgets.sparkline.sparklineBitmapSize
import earth.mention.widgets.trends.card.TRENDS_CARD_SHORT_HEIGHT
import earth.mention.widgets.trends.card.TRENDS_CARD_WIDGET_SIZES
import earth.mention.widgets.trends.card.TrendsCardDensity
import earth.mention.widgets.trends.card.cardSecondaryNamesThatFit
import earth.mention.widgets.trends.card.shortCardShowsSupportingLine
import earth.mention.widgets.trends.card.trendsCardDensity
import earth.mention.widgets.trends.chips.TrendsChipDimensions
import earth.mention.widgets.trends.chips.estimateChipWidthDp
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
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

<<<<<<< HEAD
=======
    private companion object {
        /**
         * Half of the 1MB conventionally taken as the Binder transaction limit, leaving
         * the other half for the view tree, the strings and everything else the same
         * parcel carries. The same bound `PostsBitmapTest` holds its card to.
         */
        const val PAYLOAD_BUDGET_BYTES = 512L * 1024
    }

>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
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

<<<<<<< HEAD
=======
    // ── How short the card may go ───────────────────────────────────────────────────

    @Test
    fun `each of the cards declared heights maps to its own form`() {
        assertEquals(TrendsCardDensity.SHORT, trendsCardDensity(TRENDS_CARD_SHORT_HEIGHT))
        assertEquals(TrendsCardDensity.STANDARD, trendsCardDensity(110.dp))
        assertEquals(TrendsCardDensity.FULL, trendsCardDensity(180.dp))
        assertEquals(TrendsCardDensity.FULL, trendsCardDensity(320.dp))
    }

    @Test
    fun `every declared size reaches a form, and every form is reached`() {
        // A vacuity floor. If this fails, either a declared size has become unreachable
        // — still composed into every RemoteViews, drawing a form nobody asked for — or a
        // form has become dead code with no size that selects it.
        val forms = TRENDS_CARD_WIDGET_SIZES.map { trendsCardDensity(it.height) }

        assertEquals(6, TRENDS_CARD_WIDGET_SIZES.size)
        assertEquals(TrendsCardDensity.entries.toSet(), forms.toSet())
        // Two widths at the short height and two at the standard one; the taller pair are
        // both FULL, which is why the set is six and not the four forms × widths would be.
        assertEquals(2, forms.count { it == TrendsCardDensity.SHORT })
        assertEquals(2, forms.count { it == TrendsCardDensity.STANDARD })
        assertEquals(2, forms.count { it == TrendsCardDensity.FULL })
    }

    @Test
    fun `a taller card never shows less than a shorter one`() {
        val heights = listOf(0, 40, 59, 60, 109, 110, 179, 180, 320, 1000)

        heights.zipWithNext().forEach { (shorter, taller) ->
            assertTrue(
                "${shorter}dp gave ${trendsCardDensity(shorter.dp)}, " +
                    "${taller}dp gave ${trendsCardDensity(taller.dp)}",
                trendsCardDensity(taller.dp).ordinal >= trendsCardDensity(shorter.dp).ordinal,
            )
        }
    }

    @Test
    fun `a height no breakpoint declared still lands on a form`() {
        // The platform hands over the nearest DECLARED size, but a display-density change
        // or a launcher with its own ideas can still produce anything.
        assertEquals(TrendsCardDensity.SHORT, trendsCardDensity(0.dp))
        assertEquals(TrendsCardDensity.SHORT, trendsCardDensity(40.dp))
        assertEquals(TrendsCardDensity.SHORT, trendsCardDensity(109.dp))
        assertEquals(TrendsCardDensity.STANDARD, trendsCardDensity(179.dp))
        assertEquals(TrendsCardDensity.FULL, trendsCardDensity(1000.dp))
    }

    @Test
    fun `the short form keeps its supporting line at the default font setting`() {
        assertTrue(shortCardShowsSupportingLine(TRENDS_CARD_SHORT_HEIGHT, fontScale = 1f))
    }

    @Test
    fun `the resize floor is the height the short form actually needs`() {
        // 8dp of padding either side plus a 20sp name and a 12sp line at 1.3× their font
        // size is 57.6dp, so 58dp is the arithmetic floor and the declared 60dp carries a
        // little slack. A floor picked from ambition rather than from the layout would
        // pass the assertion above and fail this one.
        assertTrue(
            "58dp is the arithmetic floor and must hold both lines",
            shortCardShowsSupportingLine(58.dp, fontScale = 1f),
        )
        assertFalse(
            "57dp cannot hold both lines, so a rule that claims it does is not measuring",
            shortCardShowsSupportingLine(57.dp, fontScale = 1f),
        )
        assertTrue(
            "the declared floor should sit above the arithmetic one, not on it",
            TRENDS_CARD_SHORT_HEIGHT > 58.dp,
        )
    }

    @Test
    fun `the short form drops its supporting line rather than clipping it for a large font`() {
        // At the floor there are 44dp for 41.6dp of text, so one step up the font scale
        // spends the slack — and a RemoteViews does not shrink or wrap the overflow, it
        // cuts it in half.
        assertFalse(
            "at ${TRENDS_CARD_SHORT_HEIGHT.value}dp and a 1.3 font scale the supporting line clips",
            shortCardShowsSupportingLine(TRENDS_CARD_SHORT_HEIGHT, fontScale = 1.3f),
        )
        assertFalse(
            "at ${TRENDS_CARD_SHORT_HEIGHT.value}dp and a 2.0 font scale even less fits",
            shortCardShowsSupportingLine(TRENDS_CARD_SHORT_HEIGHT, fontScale = 2f),
        )
        // …and it comes back as soon as a placement is tall enough to hold it, which is
        // what makes this a room check and not a font-size opinion.
        assertTrue(
            "90dp holds both lines at a 1.3 font scale, so the line must return",
            shortCardShowsSupportingLine(90.dp, fontScale = 1.3f),
        )
    }

    @Test
    fun `the short breakpoints add no chart bitmap to the payload`() {
        val drawnCharts = TRENDS_CARD_WIDGET_SIZES
            .filter { trendsCardDensity(it.height) != TrendsCardDensity.SHORT }
        val shortSizes = TRENDS_CARD_WIDGET_SIZES
            .filter { trendsCardDensity(it.height) == TrendsCardDensity.SHORT }

        // Worst case for one update: SizeMode.Responsive composes every declared size into
        // the ONE RemoteViews the launcher receives, so this total is what has to be
        // survivable — not the largest single chart.
        val bytes = drawnCharts.sumOf { chartBytes(it) }

        assertEquals(4, drawnCharts.size)
        assertEquals(306_600L, bytes)
        assertTrue("$bytes bytes across ${drawnCharts.size} charts", bytes < PAYLOAD_BUDGET_BYTES)

        // What the two short sizes would have cost had they kept the chart, and the
        // vacuity floor for the assertion above: the band's 40dp minimum means a 60dp card
        // gets a 40dp band, two thirds of the surface, whether or not text can be read
        // over it. Omitting the chart there is a legibility decision that happens to be
        // free; this is the number it is free of.
        assertEquals(2, shortSizes.size)
        assertEquals(57_600L, shortSizes.sumOf { chartBytes(it) })
    }

    /** Bytes of chart bitmap one declared size contributes, at ARGB_8888. */
    private fun chartBytes(size: DpSize): Long {
        val bitmap = checkNotNull(sparklineBitmapSize(size.width, sparklineBandHeight(size.height)))
        return bitmap.widthPx.toLong() * bitmap.heightPx.toLong() * Int.SIZE_BYTES
    }

    // ── The resources the launcher reads it from ─────────────────────────────────────

    @Test
    fun `the resize floor the launcher is given is the height the layout declares`() {
        // The only place these two have to agree, and nothing else can check it: a Glance
        // layout cannot read a dimen, and the provider XML cannot read Kotlin. Drift means
        // the launcher permits a drag to a height no breakpoint was designed for, or
        // forbids the one that was.
        val match = Regex("""<dimen name="mention_trends_card_widget_min_resize_height">(\d+)dp<""")
            .find(widgetRes("values/dimens.xml"))

        assertNotNull("the card's own min-resize-height dimen is gone from dimens.xml", match)
        assertEquals(
            TRENDS_CARD_SHORT_HEIGHT.value.toInt(),
            checkNotNull(match).groupValues[1].toInt(),
        )
    }

    @Test
    fun `the card asks for its own resize floor and the other two keep the shared one`() {
        // The trap this variant's shorter floor exists to avoid: the shared dimen carries
        // no `card_` in its name, so lowering IT would let the ranked list and the chip
        // cloud shrink to a height at which each shows one row of nothing useful.
        assertTrue(
            "the card still points at the shared floor, so it cannot be dragged shorter",
            widgetRes("xml/mention_trends_card_widget_info.xml")
                .contains("""minResizeHeight="@dimen/mention_trends_card_widget_min_resize_height""""),
        )
        listOf("list", "chips").forEach { variant ->
            assertTrue(
                "the $variant widget should still take the shared floor",
                widgetRes("xml/mention_trends_${variant}_widget_info.xml")
                    .contains("""minResizeHeight="@dimen/mention_trends_widget_min_resize_height""""),
            )
        }
        assertTrue(
            "the shared floor should still be two cells of height",
            widgetRes("values/dimens.xml")
                .contains("""<dimen name="mention_trends_widget_min_resize_height">110dp<"""),
        )
    }

    /**
     * A resource file's text, read from the module's own source tree.
     *
     * Resolved against several candidate roots rather than one, because a unit test's
     * working directory belongs to the build rather than to the test; it fails loudly with
     * the directory it looked from, so a moved file can never read as a passing check.
     */
    private fun widgetRes(relative: String): String {
        val roots = listOf("src/main/res", "android/src/main/res", "modules/mention-widgets/android/src/main/res")
        val file = roots.map { File(it, relative) }.firstOrNull { it.isFile }

        assertNotNull(
            "no $relative under $roots, from ${System.getProperty("user.dir")}",
            file,
        )
        return checkNotNull(file).readText()
    }

>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
    @Test
    fun `a name estimate scales with its length`() {
        val short = estimateTextWidthDp("ai", 14f, 1f)
        val long = estimateTextWidthDp("#tradeshow", 14f, 1f)

        assertTrue("$short vs $long", long > short)
        assertEquals(2 * 14f * AVERAGE_GLYPH_WIDTH_RATIO, short, 0.001f)
    }
}
