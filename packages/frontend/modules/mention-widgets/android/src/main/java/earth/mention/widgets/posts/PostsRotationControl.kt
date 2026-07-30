package earth.mention.widgets.posts

import android.content.Context
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.updateAll

/**
 * Moving through the rotation by hand.
 *
 * ## Why there are buttons at all
 *
 * A home-screen widget is `RemoteViews`, and `RemoteViews` has no gestures — Glance exposes
 * no `Swipe`, `onSwipe` or drag of any kind, and no app can add one. So the pips beside the
 * byline promised something the platform cannot deliver: they looked like a carousel's dots
 * and nothing moved when you dragged them.
 *
 * Taps are the one input a widget does have, through [ActionCallback]. These two make the
 * pips honest — a position indicator for something the reader can actually move.
 *
 * ## Why both callbacks route through one function
 *
 * Each step has to do three things in order, and getting the order wrong is what would make
 * the control feel broken rather than look broken: write the new position, redraw every
 * widget, then push the automatic timer back. If the redraw came first it would paint the
 * position the tap replaced; if the timer were not reset, a rotation about to turn over on
 * its own would jump a second after the user's tap and lose their place.
 */

/** Which way a step goes. */
internal enum class RotationStep { NEXT, PREVIOUS }

/**
 * Apply one step and make it visible everywhere.
 *
 * `updateAll` rather than the tapped widget alone: two posts widgets share one app-scoped
 * rotation (see `PostsWidget.stateDefinition`), so redrawing only the one that was tapped
 * would leave the other showing a position that is no longer stored.
 */
internal suspend fun applyRotationStep(context: Context, step: RotationStep) {
    when (step) {
        RotationStep.NEXT -> PostsStore.advance(context)
        RotationStep.PREVIOUS -> PostsStore.retreat(context)
    }
    PostsWidget().updateAll(context)
    PostsRefreshScheduler.restartAutoAdvance(context)
}

/** The card's forward control. */
internal class NextPostAction : ActionCallback {
    override suspend fun onAction(
        context: Context,
        glanceId: GlanceId,
        parameters: ActionParameters,
    ) {
        applyRotationStep(context, RotationStep.NEXT)
    }
}

/** The card's back control. */
internal class PreviousPostAction : ActionCallback {
    override suspend fun onAction(
        context: Context,
        glanceId: GlanceId,
        parameters: ActionParameters,
    ) {
        applyRotationStep(context, RotationStep.PREVIOUS)
    }
}
