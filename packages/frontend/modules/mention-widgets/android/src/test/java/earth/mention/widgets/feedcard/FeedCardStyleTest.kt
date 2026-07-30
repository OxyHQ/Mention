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
        assertTrue(textMaxLines(FeedCardSize.SMALL) < textMaxLines(FeedCardSize.MEDIUM))
        assertTrue(textMaxLines(FeedCardSize.MEDIUM) < textMaxLines(FeedCardSize.LARGE))
        // Two is the floor worth drawing: one line of a post is a fragment.
        assertTrue(textMaxLines(FeedCardSize.SMALL) >= 2)
    }

    // ── The text budget ─────────────────────────────────────────────────────────────

    @Test
    fun `a bigger card holds more text than a smaller one`() {
        val small = textBudgetChars(FeedCardSize.SMALL, SMALL_CONTENT_WIDTH, 1f)
        val medium = textBudgetChars(FeedCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, 1f)
        val large = textBudgetChars(FeedCardSize.LARGE, LARGE_CONTENT_WIDTH, 1f)

        assertTrue("the small card must hold the least: $small", small < medium)
        assertTrue("the large card must hold the most: $large", medium < large)
        // A vacuity floor. Every budget is a product of several factors, so a zero anywhere
        // in the chain would otherwise pass every ordering assertion above.
        assertTrue("a budget of $small characters is not a design", small >= 20)
    }

    @Test
    fun `a larger font setting shrinks the budget`() {
        val standard = textBudgetChars(FeedCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, 1f)
        val large = textBudgetChars(FeedCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, 1.3f)
        val largest = textBudgetChars(FeedCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, 2f)

        // Left out, a card at a 1.3 scale hands its TextView a third more text than fits.
        assertTrue(large < standard)
        assertTrue(largest < large)
    }

    @Test
    fun `a degenerate width or font scale yields no budget rather than an exception`() {
        assertEquals(0, textBudgetChars(FeedCardSize.MEDIUM, 0f, 1f))
        assertEquals(0, textBudgetChars(FeedCardSize.MEDIUM, -10f, 1f))
        // A zero font scale would divide by zero; it is treated as the default instead.
        assertTrue(textBudgetChars(FeedCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, 0f) > 0)
    }

    @Test
    fun `the stored text cap is the largest budget any design can reach`() {
        // Derived from the breakpoint table rather than written down, so it cannot fall out
        // of step with it — a store holding less than a card can draw would truncate text
        // that had room on screen.
        assertEquals(LARGEST_TEXT_BUDGET_CHARS, MAX_STORED_TEXT_CHARS)
        assertEquals(
            LARGEST_TEXT_BUDGET_CHARS,
            textBudgetChars(FeedCardSize.LARGE, LARGE_CONTENT_WIDTH, 0.85f),
        )

        // …and it really is the largest: no design at any supported font scale exceeds it.
        FeedCardSize.entries.forEach { design ->
            listOf(0.85f, 1f, 1.3f, 2f).forEach { scale ->
                val budget = textBudgetChars(design, LARGE_CONTENT_WIDTH, scale)
                assertTrue(
                    "$design at scale $scale wants $budget characters, more than the store keeps",
                    budget <= MAX_STORED_TEXT_CHARS,
                )
            }
        }
    }

    // ── Truncation ──────────────────────────────────────────────────────────────────

    @Test
    fun `the longest real post is truncated for every design`() {
        assertEquals(1708, LONGEST_POST.length)

        FeedCardSize.entries.forEach { design ->
            val budget = textBudgetChars(design, MEDIUM_CONTENT_WIDTH, 1f)
            val drawn = truncateToBudget(LONGEST_POST, budget)

            assertTrue("$design drew ${drawn.length} of a $budget budget", drawn.length <= budget)
            assertTrue("$design must show it was cut", drawn.endsWith("…"))
            assertTrue("$design must still show something", drawn.length > 1)
        }
    }

    @Test
    fun `text that fits is left exactly as it is`() {
        val budget = textBudgetChars(FeedCardSize.LARGE, LARGE_CONTENT_WIDTH, 1f)

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
}
