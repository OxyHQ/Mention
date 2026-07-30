package earth.mention.widgets.feedcard

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The per-breakpoint design of the trending-posts card.
 *
 * These are the decisions that make the card DESIGNED PER SIZE rather than one layout
 * stretched — which design a placement gets, what each one drops, and how much text each can
 * hold. Every one of them fails invisibly: a widget that looks right at the size it was
 * developed at and runs out of room at another.
 *
 * The 1708-character post used below is the longest observed in the live explore feed.
 */
class FeedCardStyleTest {

    private companion object {
        /** Content width inside each design at a 4-cell-wide placement. */
        const val SMALL_CONTENT_WIDTH = 250f - 12f * 2
        const val MEDIUM_CONTENT_WIDTH = 250f - 16f * 2
        const val LARGE_CONTENT_WIDTH = 320f - 16f * 2

        /**
         * The resize FLOOR the provider declares, from `dimens_posts.xml` — 4 cells wide by
         * 2 tall. The ceiling has a Kotlin constant ([FEED_CARD_MAX_PLACEMENT]); the floor does
         * not, because nothing in the layout is measured against it.
         */
        val MIN_RESIZE_WIDTH = 250.dp
        val MIN_RESIZE_HEIGHT = 110.dp

        /** Where the medium design starts — 3 cells. */
        val MEDIUM_HEIGHT = 180.dp

        /** Where the large design starts — 5 cells. */
        val LARGE_HEIGHT = 320.dp

        /** The longest real post, and a realistic one. */
        val LONGEST_POST = "word ".repeat(341) + "end"
        val TYPICAL_POST = "Microsoft confirms Copilot super app coming this year"
    }

    // ── Which design a placement gets ───────────────────────────────────────────────

    @Test
    fun `each cell count maps to its own design`() {
        assertEquals(FeedCardSize.SMALL, feedCardSize(250.dp, 110.dp))
        assertEquals(FeedCardSize.MEDIUM, feedCardSize(250.dp, 180.dp))
        assertEquals(FeedCardSize.LARGE, feedCardSize(320.dp, 320.dp))
    }

    @Test
    fun `every design is reachable inside the provider's own resize range`() {
        // A vacuity floor: if this ever fails, the breakpoint boundaries have drifted away
        // from the range the provider allows and one design has become dead code — reachable
        // only at a size the launcher will not let the user pick.
        val reachable = listOf(
            DpSize(MIN_RESIZE_WIDTH, MIN_RESIZE_HEIGHT),
            DpSize(MIN_RESIZE_WIDTH, MEDIUM_HEIGHT),
            FEED_CARD_MAX_PLACEMENT,
        ).map { feedCardSize(it.width, it.height) }

        assertEquals(FeedCardSize.entries.toSet(), reachable.toSet())
        assertEquals(reachable.size, reachable.toSet().size)
    }

    @Test
    fun `the large design needs the width as well as the height`() {
        // A 120dp image slot on a 250dp-wide card would leave the text a strip.
        assertEquals(FeedCardSize.MEDIUM, feedCardSize(250.dp, 320.dp))
        assertEquals(FeedCardSize.MEDIUM, feedCardSize(319.dp, 400.dp))
        assertEquals(FeedCardSize.LARGE, feedCardSize(320.dp, 320.dp))
    }

    @Test
    fun `a size no breakpoint declared still lands on a design`() {
        // A launcher is free to hand over anything inside the resize range, and something
        // outside it after a display-density change.
        assertEquals(FeedCardSize.SMALL, feedCardSize(110.dp, 110.dp))
        assertEquals(FeedCardSize.SMALL, feedCardSize(250.dp, 179.dp))
        assertEquals(FeedCardSize.MEDIUM, feedCardSize(300.dp, 200.dp))
        assertEquals(FeedCardSize.LARGE, feedCardSize(500.dp, 500.dp))
    }

    // ── What each design drops ──────────────────────────────────────────────────────

    @Test
    fun `a taller card shows more lines of text`() {
        val small = textMaxLines(FeedCardSize.SMALL, MIN_RESIZE_HEIGHT, 1f)
        val medium = textMaxLines(FeedCardSize.MEDIUM, MEDIUM_HEIGHT, 1f)
        val large = textMaxLines(FeedCardSize.LARGE, LARGE_HEIGHT, 1f)

        assertTrue("small=$small medium=$medium", small < medium)
        assertTrue("medium=$medium large=$large", medium < large)
        // A vacuity floor: every count is a division, so a zero anywhere in the chain would
        // satisfy the ordering above while drawing nothing.
        assertTrue("a card that shows $large lines is not a design", large >= 5)
    }

    @Test
    fun `the line count follows the height it was actually given, not the design`() {
        // The whole point of deriving it. A card 100dp taller is several lines richer, and
        // before this was derived it drew the same five lines and clipped the rest — which
        // is what "the text gets cut" looked like on a real launcher.
        val declared = textMaxLines(FeedCardSize.LARGE, LARGE_HEIGHT, 1f)
        val roomier = textMaxLines(FeedCardSize.LARGE, LARGE_HEIGHT + 100.dp, 1f)
        assertTrue("declared=$declared roomier=$roomier", roomier > declared)
    }

    @Test
    fun `a card with no room draws no text rather than a line sliced in half`() {
        // The bug this replaces: the count was floored at one, so the smallest placement
        // promised a line it had nowhere to put and the TextView drew it clipped through the
        // middle. Zero is a real answer — the card becomes a picture with an attribution.
        assertEquals(0, textMaxLines(FeedCardSize.SMALL, 72.dp, 1f))
        assertEquals(0, textMaxLines(FeedCardSize.SMALL, 40.dp, 1f))
        assertEquals(0, textMaxLines(FeedCardSize.SMALL, 0.dp, 1f))
    }

    @Test
    fun `the brand row is dropped before the last line of text is`() {
        // As the card shrinks, something has to go. The brand row goes first: it is context
        // for the post, while the words are the post. The byline is never a candidate — a
        // card that cannot name its author could be attributed to anyone.
        val heightThatNeedsTheRoom = 100.dp

        assertTrue(
            "the brand row should yield its 28dp so a line of text survives",
            !showsBrandRow(FeedCardSize.SMALL, heightThatNeedsTheRoom, 1f),
        )
        assertTrue(
            "dropping it must actually buy a line",
            textMaxLines(FeedCardSize.SMALL, heightThatNeedsTheRoom, 1f) >= 1,
        )
        // A card with room for both keeps both.
        assertTrue(showsBrandRow(FeedCardSize.MEDIUM, MEDIUM_HEIGHT, 1f))
    }

    @Test
    fun `a larger font setting costs lines rather than clipping them`() {
        val standard = textMaxLines(FeedCardSize.LARGE, LARGE_HEIGHT, 1f)
        val accessible = textMaxLines(FeedCardSize.LARGE, LARGE_HEIGHT, 2f)
        assertTrue("standard=$standard accessible=$accessible", accessible < standard)
        assertTrue(accessible >= 1)
    }

    // ── The text budget ─────────────────────────────────────────────────────────────

    @Test
    fun `a bigger card holds more text than a smaller one`() {
        val small = textBudgetChars(FeedCardSize.SMALL, SMALL_CONTENT_WIDTH, MIN_RESIZE_HEIGHT, 1f)
        val medium = textBudgetChars(FeedCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, MEDIUM_HEIGHT, 1f)
        val large = textBudgetChars(FeedCardSize.LARGE, LARGE_CONTENT_WIDTH, LARGE_HEIGHT, 1f)

        assertTrue("the small card must hold the least: $small", small < medium)
        assertTrue("the large card must hold the most: $large", medium < large)
        // A vacuity floor. Every budget is a product of several factors, so a zero anywhere
        // in the chain would otherwise pass every ordering assertion above.
        assertTrue("a budget of $small characters is not a design", small >= 20)
    }

    @Test
    fun `a larger font setting shrinks the budget`() {
        val standard = textBudgetChars(FeedCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, MEDIUM_HEIGHT, 1f)
        val large = textBudgetChars(FeedCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, MEDIUM_HEIGHT, 1.3f)
        val largest = textBudgetChars(FeedCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, MEDIUM_HEIGHT, 2f)

        // Left out, a card at a 1.3 scale hands its TextView a third more text than fits.
        assertTrue(large < standard)
        assertTrue(largest < large)
    }

    @Test
    fun `a degenerate width or font scale yields no budget rather than an exception`() {
        assertEquals(0, textBudgetChars(FeedCardSize.MEDIUM, 0f, MEDIUM_HEIGHT, 1f))
        assertEquals(0, textBudgetChars(FeedCardSize.MEDIUM, -10f, MEDIUM_HEIGHT, 1f))
        // A zero font scale would divide by zero; it is treated as the default instead.
        assertTrue(textBudgetChars(FeedCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, MEDIUM_HEIGHT, 0f) > 0)
    }

    @Test
    fun `the stored text cap exceeds what any real placement can draw`() {
        // The cap's job is to bound every card the LAUNCHER can produce, not the one the
        // provider requests. Those differ: the launcher deals in whole cells, so a four-cell
        // placement measures 387 x 325dp against a declared 320 x 320dp ceiling. Sizing the
        // store to the request left the biggest real cards short of words — the store ran out
        // before the card did, which is what "the text gets cut" looked like.
        assertEquals(LARGEST_TEXT_BUDGET_CHARS, MAX_STORED_TEXT_CHARS)

        // A measured four-cell placement, and generous headroom past it.
        val realPlacements = listOf(
            387f to 325.dp,
            480f to 400.dp,
            520f to 480.dp,
        )
        FeedCardSize.entries.forEach { design ->
            realPlacements.forEach { (widthDp, height) ->
                listOf(0.85f, 1f, 1.3f, 2f).forEach { scale ->
                    val budget = textBudgetChars(design, widthDp, height, scale)
                    assertTrue(
                        "$design at ${widthDp}x$height scale $scale wants $budget characters, " +
                            "more than the $MAX_STORED_TEXT_CHARS the store keeps",
                        budget <= MAX_STORED_TEXT_CHARS,
                    )
                }
            }
        }

        // A vacuity floor. Every budget is a product of several factors, so a zero would
        // satisfy every bound above while storing nothing at all.
        assertTrue("a cap of $MAX_STORED_TEXT_CHARS characters is not a design", MAX_STORED_TEXT_CHARS >= 200)
    }

    // ── Truncation ──────────────────────────────────────────────────────────────────

    @Test
    fun `the longest real post is truncated for every design`() {
        assertEquals(1708, LONGEST_POST.length)

        FeedCardSize.entries.forEach { design ->
            val budget = textBudgetChars(design, MEDIUM_CONTENT_WIDTH, LARGE_HEIGHT, 1f)
            val drawn = truncateToBudget(LONGEST_POST, budget)

            assertTrue("$design drew ${drawn.length} of a $budget budget", drawn.length <= budget)
            assertTrue("$design must show it was cut", drawn.endsWith("…"))
            assertTrue("$design must still show something", drawn.length > 1)
        }
    }

    @Test
    fun `text that fits is left exactly as it is`() {
        val budget = textBudgetChars(FeedCardSize.LARGE, LARGE_CONTENT_WIDTH, LARGE_HEIGHT, 1f)

        // No card carries an ellipsis it did not earn.
        assertEquals(TYPICAL_POST, truncateToBudget(TYPICAL_POST, budget))
        assertEquals("short", truncateToBudget("short", 5))
    }

    @Test
    fun `truncation prefers a word boundary`() {
        assertEquals("hello world…", truncateToBudget("hello world again", 13))
    }

    @Test
    fun `a single long token is cut mid-word rather than back to nothing`() {
        // A URL or a compound would otherwise pull the cut back past almost all of the
        // budget, leaving a card with two words on it.
        val oneToken = "a".repeat(50)
        assertEquals("${"a".repeat(9)}…", truncateToBudget(oneToken, 10))

        val shortHeadThenToken = "ab " + "c".repeat(30)
        val drawn = truncateToBudget(shortHeadThenToken, 20)
        assertEquals(20, drawn.length)
        assertTrue("the cut must not fall back to the first word: $drawn", drawn.contains("ccc"))
    }

    @Test
    fun `a budget of nothing draws nothing`() {
        assertEquals("", truncateToBudget(TYPICAL_POST, 0))
        assertEquals("", truncateToBudget(TYPICAL_POST, -1))
        // One character of budget cannot hold both content and the mark that says it was cut.
        assertEquals("…", truncateToBudget(TYPICAL_POST, 1))
    }

    @Test
    fun `empty text stays empty`() {
        // A post whose whole body was a bare URL with an image. The card draws the picture.
        assertEquals("", truncateToBudget("", 50))
    }

    @Test
    fun `the body budget errs toward showing more words, not fewer`() {
        // `maxLines` is the real bound — the TextView clips anything past it for free — so a
        // budget that runs SHORT ends a sentence with a visible ellipsis while the room it
        // needed sits empty. That is what "the text gets cut early" was: the shared 0.6 chip
        // ratio over-estimated glyph width by about a third for body text.
        //
        // Pinned against a MEASURED observation rather than a preference: 31 characters of
        // body text occupy 218dp at 17sp on a real launcher.
        val measuredChars = 31
        val measuredWidthDp = 218f
        val budget = textBudgetChars(FeedCardSize.MEDIUM, measuredWidthDp, MEDIUM_HEIGHT, 1f)
        val linesAtThatHeight = textMaxLines(FeedCardSize.MEDIUM, MEDIUM_HEIGHT, 1f)
        val perLine = budget / linesAtThatHeight

        assertTrue(
            "the budget allows $perLine characters per line where $measuredChars were measured",
            perLine >= measuredChars,
        )
    }

    @Test
    fun `the blocks always fit inside the card they were measured for`() {
        // The invariant that makes overlap impossible: padding, brand row, text block and
        // byline summed can never exceed the height the launcher gave. When they could, the
        // launcher resolved the disagreement by pushing the byline down over the text.
        val placements = listOf(72.dp, 80.dp, 110.dp, 140.dp, 180.dp, 250.dp, 320.dp, 460.dp)
        FeedCardSize.entries.forEach { design ->
            placements.forEach { height ->
                listOf(0.85f, 1f, 1.3f, 2f).forEach { scale ->
                    val lines = textMaxLines(design, height, scale)
                    val brand = if (showsBrandRow(design, height, scale)) 20f + 8f else 0f
                    // Mirrors what the layout actually emits: padding, the brand row when
                    // shown, ONE gap above the text, the text block, and the byline. The gap
                    // above the byline is the weighted spacer, which shrinks to nothing —
                    // counting it here as fixed is what made this assertion fail against
                    // correct code the first time it ran.
                    val used = cardPadding(design).value * 2 + brand +
                        (if (lines > 0) 8f else 0f) +
                        textBlockHeightDp(design, scale, lines) + 28f
                    assertTrue(
                        "$design at $height scale $scale asks for ${used}dp of a ${height.value}dp card",
                        used <= height.value,
                    )
                }
            }
        }
    }

    @Test
    fun `the text block is exactly the lines it was granted`() {
        // A vacuity floor for the invariant above: a block of zero height would satisfy every
        // bound while showing nothing.
        val lines = textMaxLines(FeedCardSize.LARGE, LARGE_HEIGHT, 1f)
        assertTrue("a large card should fit several lines, got $lines", lines >= 5)
        assertEquals(0f, textBlockHeightDp(FeedCardSize.LARGE, 1f, 0), 0.01f)
        assertTrue(textBlockHeightDp(FeedCardSize.LARGE, 1f, lines) > textBlockHeightDp(FeedCardSize.LARGE, 1f, lines - 1))
    }
}
