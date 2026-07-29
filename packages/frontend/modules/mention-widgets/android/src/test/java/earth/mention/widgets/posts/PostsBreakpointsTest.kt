package earth.mention.widgets.posts

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
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
class PostsBreakpointsTest {

    private companion object {
        /** Content width inside each design at its widest declared placement. */
        const val SMALL_CONTENT_WIDTH = 250f - 12f * 2
        const val MEDIUM_CONTENT_WIDTH = 250f - 16f * 2
        const val LARGE_CONTENT_WIDTH = 320f - 16f * 2

        /** The longest real post, and a realistic one. */
        val LONGEST_POST = "word ".repeat(341) + "end"
        val TYPICAL_POST = "Microsoft confirms Copilot super app coming this year"
    }

    // ── Which design a placement gets ───────────────────────────────────────────────

    @Test
    fun `each declared size maps to its own design`() {
        assertEquals(PostsCardSize.SMALL, postsCardSize(250.dp, 110.dp))
        assertEquals(PostsCardSize.MEDIUM, postsCardSize(250.dp, 180.dp))
        assertEquals(PostsCardSize.LARGE, postsCardSize(320.dp, 320.dp))
    }

    @Test
    fun `every declared size is reachable, and no two collapse onto one design`() {
        // A vacuity floor: if this ever fails, the breakpoint boundaries have drifted away
        // from the set the widget declares and one design has become dead code that is still
        // being composed into every RemoteViews.
        val designs = POSTS_WIDGET_SIZES.map { postsCardSize(it.width, it.height) }

        assertEquals(POSTS_WIDGET_SIZES.size, designs.size)
        assertEquals(POSTS_WIDGET_SIZES.size, designs.toSet().size)
        assertEquals(PostsCardSize.entries.toSet(), designs.toSet())
    }

    @Test
    fun `the large design needs the width as well as the height`() {
        // A 120dp image slot on a 250dp-wide card would leave the text a strip.
        assertEquals(PostsCardSize.MEDIUM, postsCardSize(250.dp, 320.dp))
        assertEquals(PostsCardSize.MEDIUM, postsCardSize(319.dp, 400.dp))
        assertEquals(PostsCardSize.LARGE, postsCardSize(320.dp, 320.dp))
    }

    @Test
    fun `a size no breakpoint declared still lands on a design`() {
        // A launcher is free to hand over anything inside the resize range, and something
        // outside it after a display-density change.
        assertEquals(PostsCardSize.SMALL, postsCardSize(110.dp, 110.dp))
        assertEquals(PostsCardSize.SMALL, postsCardSize(250.dp, 179.dp))
        assertEquals(PostsCardSize.MEDIUM, postsCardSize(300.dp, 200.dp))
        assertEquals(PostsCardSize.LARGE, postsCardSize(500.dp, 500.dp))
    }

    // ── What each design drops ──────────────────────────────────────────────────────

    @Test
    fun `the smallest design has no image slot at all`() {
        // 110dp of height holds a brand row, two lines and a byline. An image would have
        // about 20dp left, which is a stripe rather than a picture.
        assertNull(imageSlotHeight(PostsCardSize.SMALL))
    }

    @Test
    fun `the larger designs have an image slot, and it grows with the card`() {
        val medium = requireNotNull(imageSlotHeight(PostsCardSize.MEDIUM))
        val large = requireNotNull(imageSlotHeight(PostsCardSize.LARGE))

        assertTrue("the large slot must be taller than the medium one", large > medium)
    }

    @Test
    fun `a taller card shows more lines of text`() {
        assertTrue(textMaxLines(PostsCardSize.SMALL) < textMaxLines(PostsCardSize.MEDIUM))
        assertTrue(textMaxLines(PostsCardSize.MEDIUM) < textMaxLines(PostsCardSize.LARGE))
        // Two is the floor worth drawing: one line of a post is a fragment.
        assertTrue(textMaxLines(PostsCardSize.SMALL) >= 2)
    }

    @Test
    fun `the image slot spans the content width, inside the design's own padding`() {
        assertEquals(
            (250f - 16f * 2).dp,
            imageSlotWidth(PostsCardSize.MEDIUM, 250.dp),
        )
        // The small design pads tighter, so at the same card width its content is wider —
        // which is exactly why the padding is read from the design and not from a constant.
        assertEquals(
            (250f - 12f * 2).dp,
            imageSlotWidth(PostsCardSize.SMALL, 250.dp),
        )
    }

    // ── The text budget ─────────────────────────────────────────────────────────────

    @Test
    fun `a bigger card holds more text than a smaller one`() {
        val small = textBudgetChars(PostsCardSize.SMALL, SMALL_CONTENT_WIDTH, 1f)
        val medium = textBudgetChars(PostsCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, 1f)
        val large = textBudgetChars(PostsCardSize.LARGE, LARGE_CONTENT_WIDTH, 1f)

        assertTrue("the small card must hold the least: $small", small < medium)
        assertTrue("the large card must hold the most: $large", medium < large)
        // A vacuity floor. Every budget is a product of several factors, so a zero anywhere
        // in the chain would otherwise pass every ordering assertion above.
        assertTrue("a budget of $small characters is not a design", small >= 20)
    }

    @Test
    fun `a larger font setting shrinks the budget`() {
        val standard = textBudgetChars(PostsCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, 1f)
        val large = textBudgetChars(PostsCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, 1.3f)
        val largest = textBudgetChars(PostsCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, 2f)

        // Left out, a card at a 1.3 scale hands its TextView a third more text than fits.
        assertTrue(large < standard)
        assertTrue(largest < large)
    }

    @Test
    fun `a degenerate width or font scale yields no budget rather than an exception`() {
        assertEquals(0, textBudgetChars(PostsCardSize.MEDIUM, 0f, 1f))
        assertEquals(0, textBudgetChars(PostsCardSize.MEDIUM, -10f, 1f))
        // A zero font scale would divide by zero; it is treated as the default instead.
        assertTrue(textBudgetChars(PostsCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, 0f) > 0)
    }

    @Test
    fun `the stored text cap is the largest budget any design can reach`() {
        // Derived from the breakpoint table rather than written down, so it cannot fall out
        // of step with it — a store holding less than a card can draw would truncate text
        // that had room on screen.
        assertEquals(LARGEST_TEXT_BUDGET_CHARS, MAX_STORED_TEXT_CHARS)
        assertEquals(
            LARGEST_TEXT_BUDGET_CHARS,
            textBudgetChars(PostsCardSize.LARGE, LARGE_CONTENT_WIDTH, 0.85f),
        )

        // …and it really is the largest: no design at any supported font scale exceeds it.
        PostsCardSize.entries.forEach { design ->
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

        PostsCardSize.entries.forEach { design ->
            val budget = textBudgetChars(design, MEDIUM_CONTENT_WIDTH, 1f)
            val drawn = truncateToBudget(LONGEST_POST, budget)

            assertTrue("$design drew ${drawn.length} of a $budget budget", drawn.length <= budget)
            assertTrue("$design must show it was cut", drawn.endsWith("…"))
            assertTrue("$design must still show something", drawn.length > 1)
        }
    }

    @Test
    fun `text that fits is left exactly as it is`() {
        val budget = textBudgetChars(PostsCardSize.LARGE, LARGE_CONTENT_WIDTH, 1f)

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
