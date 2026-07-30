package earth.mention.widgets.following

import android.content.Context
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.updateAll
import earth.mention.widgets.feedcard.RotationStep
import earth.mention.widgets.feedcard.applyRotationStep

/**
 * Moving through the following rotation by hand.
 *
 * TWO CALLBACK CLASSES OF ITS OWN, rather than reusing the trending widget's, and that is a
 * requirement rather than a preference: Glance instantiates an [ActionCallback] reflectively by
 * class, so a shared pair would step whichever rotation the shared class happened to name — a tap
 * on the following card would move the trending card, or nothing at all.
 *
 * A step needs no session and no network: it moves a cursor over posts that are already stored,
 * which is why it works while offline and costs no token mint. The ORDER of what it does is
 * shared with the trending widget and lives in `applyRotationStep`.
 */

/** Apply one step to the FOLLOWING rotation. */
private suspend fun step(context: Context, step: RotationStep) {
    applyRotationStep(
        context = context,
        step = step,
        store = FollowingStore,
        redraw = { FollowingWidget().updateAll(context) },
        restartAutoAdvance = { FollowingRefreshScheduler.restartAutoAdvance(context) },
    )
}

/** The card's forward control. */
internal class NextFollowingPostAction : ActionCallback {
    override suspend fun onAction(
        context: Context,
        glanceId: GlanceId,
        parameters: ActionParameters,
    ) {
        step(context, RotationStep.NEXT)
    }
}

/** The card's back control. */
internal class PreviousFollowingPostAction : ActionCallback {
    override suspend fun onAction(
        context: Context,
        glanceId: GlanceId,
        parameters: ActionParameters,
    ) {
        step(context, RotationStep.PREVIOUS)
    }
}
