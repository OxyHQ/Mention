package earth.mention.widgets.posts

import android.content.Context
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.updateAll

/**
 * Move the rotation on, because the reader asked for the next post.
 *
 * WHY THIS EXISTS. The card shows one post of five and draws position pips for the rest, and
 * for a while the only thing that moved the rotation was the refresh tick — WorkManager's
 * floor is fifteen minutes, so nobody watching the widget ever saw it turn over. The pips
 * then promised an affordance that does not exist: a widget is `RemoteViews`, glance-appwidget
 * 1.1.1 has no `Swipe`, no `onSwipe` and no `drag`, and there is no gesture support of any
 * kind on this surface to simulate one with. A TAP running a callback is the whole of what a
 * widget can do, and it is enough — this is what the pips now indicate the position of.
 *
 * PUBLIC, unlike almost everything else in this module, for two reasons that both come from
 * outside it: Glance's own `ActionCallbackBroadcastReceiver` instantiates the class
 * reflectively by name, and glance-appwidget's consumer ProGuard rule is
 * `-keep public class * extends androidx.glance.appwidget.action.ActionCallback`, which would
 * not match a class R8 saw as anything else. Same reasoning as `PostsWidgetReceiver`, which is
 * public because the manifest names it.
 *
 * It takes no parameters. Which post to move to is not the tap's business: [PostsRepository]
 * decides that from the rotation it holds, so two widgets tapped in either order, or a tap
 * racing the refresh, can never disagree about where the rotation is.
 */
class PostsAdvanceAction : ActionCallback {

    override suspend fun onAction(
        context: Context,
        glanceId: GlanceId,
        parameters: ActionParameters,
    ) {
        // PERSIST FIRST, then redraw. Reversed, the redraw would compose the position that is
        // still in the store — the card would appear not to react to the tap and would only
        // catch up on the next write.
        PostsRepository.advance(context)

        // The redraw is not redundant with the store's `Flow`. A widget whose Glance session
        // is running does recompose on the write, but this callback also runs when the process
        // was started by the broadcast itself, and then there is no session collecting
        // anything — without this the launcher would keep showing the previous post until the
        // next tick. `updateAll` re-enters `provideGlance`, which reads the position that was
        // just written.
        //
        // ALL of them, not `update(context, glanceId)` for the one that was tapped: the
        // rotation is a single app-scoped store, so a second posts widget on the same home
        // screen shows the same post, and leaving it on the previous one would be two widgets
        // disagreeing about a position they share.
        PostsWidget().updateAll(context)

        // Nothing here touches the network, deliberately. A broadcast has a few seconds to
        // finish, and the picture for the post being moved to is already on disk: the refresh
        // worker caches the whole rotation's images, not just the visible post's, precisely so
        // that a tap never has to wait for one.
    }
}
