package earth.mention.widgets.feedcard

import android.content.Context

/**
 * Moving through a rotation by hand — the ORDER of it, in one place.
 *
 * ## Why the cards have buttons at all
 *
 * A home-screen widget is `RemoteViews`, and `RemoteViews` has no gestures — Glance exposes no
 * `Swipe`, `onSwipe` or drag of any kind, and no app can add one. So position pips on their own
 * promised something the platform cannot deliver: they looked like a carousel's dots and nothing
 * moved when you dragged them. Taps are the one input a widget does have, and these make the pips
 * honest.
 *
 * ## Why the order lives here rather than in each widget
 *
 * Each step has to do three things IN THIS ORDER, and getting it wrong is what would make the
 * control feel broken rather than merely look it. Both widgets need the same three, so the
 * sequence is written once — the callbacks themselves must stay per-widget (Glance instantiates
 * them reflectively by class), but the rule they follow does not have to be.
 */
internal enum class RotationStep { NEXT, PREVIOUS }

/**
 * Apply one step: persist, redraw, then push the automatic turn back.
 *
 *  1. PERSIST FIRST. Reversed, the redraw would compose the position that is still in the store —
 *     the card would appear not to react to the tap and would only catch up on the next write.
 *  2. REDRAW, and every widget of this kind rather than the one that was tapped: the rotation is
 *     a single app-scoped store, so a sibling left on the previous post would be two widgets
 *     disagreeing about a position they share. The redraw is not redundant with the store's
 *     `Flow` — a callback can run in a process the broadcast itself started, where no Glance
 *     session is collecting anything.
 *  3. RESTART THE TIMER. Without it, a card tapped a second before an automatic turn was due
 *     would jump again immediately and lose the post the reader had just chosen.
 *
 * Nothing here touches the network, deliberately: a broadcast has a few seconds to finish, and
 * the picture for the post being moved to is already on disk.
 */
internal suspend fun applyRotationStep(
    context: Context,
    step: RotationStep,
    store: FeedRotationStore,
    redraw: suspend () -> Unit,
    restartAutoAdvance: () -> Unit,
) {
    when (step) {
        RotationStep.NEXT -> store.advance(context)
        RotationStep.PREVIOUS -> store.retreat(context)
    }
    redraw()
    restartAutoAdvance()
}
