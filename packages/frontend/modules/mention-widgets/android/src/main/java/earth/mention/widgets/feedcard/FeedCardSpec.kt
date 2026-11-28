package earth.mention.widgets.feedcard

import android.content.Context
import androidx.annotation.StringRes

/**
 * Everything that differs between one feed-card widget and another.
 *
 * There is ONE card implementation ([FeedCardContent]) and two widgets over it — the
 * trending-posts card reading Explore, and the following card reading the viewer's own
 * timeline. This is the seam, and it is deliberately narrow: two strings, a destination and
 * an image cache. Everything else about the card — its three breakpoints, its bitmap budget,
 * its truncation, its byline, its background picture — is the same code for both, which is
 * the property that stops the approved design from drifting apart in two places.
 *
 * It used to carry each widget's own pair of rotation ACTIONS, which is why a spec is an
 * `object` per widget rather than one data class instance: Glance instantiates an
 * `ActionCallback` reflectively by class, so two widgets could not share one pair without a
 * tap on either stepping both rotations. The controls are gone — the card turns over by
 * itself — and the per-widget `object` is now only about the image cache below.
 */
internal interface FeedCardSpec {

    /**
     * The quiet line above the post, saying where it came from ("TRENDING", "FOLLOWING").
     *
     * All caps in the string resource itself: Glance's `TextStyle` has no text-transform,
     * and uppercasing per locale in code is not something a widget can do correctly.
     */
    @get:StringRes
    val eyebrow: Int

    /** Shown before the first successful fetch. Never replaces content. */
    @get:StringRes
    val emptyMessage: Int

    /**
     * Where the empty and signed-out states' button goes — the in-app feed this card is
     * drawn from, so a reader who taps it lands on the same content at full size.
     */
    fun feedScreenUrl(context: Context): String

    /**
     * Where this widget's pictures are on disk.
     *
     * Per-widget rather than shared because [FeedImageCache.prune] is exact — see the note on
     * that class. The card only ever READS from it: a composition runs while the launcher
     * waits, so it can never download anything.
     */
    val images: FeedImageCache
}

/**
 * What the card has to draw, as decided by the widget rather than by the layout.
 *
 * Three outcomes rather than a nullable rotation, because a card with no posts means two
 * completely different things and the reader must be able to tell them apart: "nothing has
 * been fetched yet" is a first run that will fill itself in, while "there is no session"
 * needs the reader to do something. Collapsing them would either promise content that will
 * never arrive or accuse a signed-in user of being signed out.
 */
internal sealed interface FeedCardState {

    /**
     * Draw the rotation. An EMPTY rotation here is the first-run state — a fetch that has
     * not happened or has not yet succeeded — and never an error: a failed refresh leaves
     * the previous rotation in place, so an empty one means there has never been a good
     * fetch.
     */
    data class Rotating(val rotation: FeedRotation) : FeedCardState

    /**
     * There is no usable session, and there will not be one until the user opens the app.
     *
     * Reached only by a widget whose feed needs authentication, and only on a verdict that
     * PROVES it — no credential at all, or a server rejection. Never on a network failure,
     * which keeps the last known content instead ([Rotating]).
     *
     * The message is carried here rather than on [FeedCardSpec] so that a widget which can
     * never be signed out does not have to declare a string it would never show.
     */
    data class SignedOut(@StringRes val message: Int) : FeedCardState
}
