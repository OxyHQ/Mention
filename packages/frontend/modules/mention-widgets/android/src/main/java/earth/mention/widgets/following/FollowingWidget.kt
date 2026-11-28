package earth.mention.widgets.following

import android.content.Context
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.provideContent
import androidx.glance.state.GlanceStateDefinition
import earth.mention.widgets.R
import earth.mention.widgets.feedcard.FeedCardContent
import earth.mention.widgets.feedcard.FeedCardState
import earth.mention.widgets.theme.MentionGlanceTheme
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import so.oxy.session.OxyBackgroundSession

/**
 * The following widget: ONE post from the viewer's own timeline at a time, rotating.
 *
 * The same card, breakpoints, rotation and payload discipline as the trending-posts widget —
 * literally the same code, over a different feed and behind a session. See
 * `earth.mention.widgets.feedcard`.
 *
 * [SizeMode.Exact] for the same reason the trending widget uses it: the picture's height is the
 * space the words leave over (`imageSlotHeight`), so composing at a DECLARED bucket rather than
 * the real placement would hand that derivation the wrong number and the whole flexible-image
 * design would silently do nothing. It also keeps the bitmap payload to the sizes the launcher
 * actually asks for — see `FeedCardBitmaps.kt`.
 *
 * ## The signed-out decision is made HERE, on every composition
 *
 * A composition cannot go to the network, so it cannot mint a token — but it can ask, with no
 * I/O at all, whether a credential exists ([OxyBackgroundSession.activeAccountId]). That is
 * deliberately the FIRST thing it does, because it is what makes the widget safe on a home
 * screen: no credential means no session, which means this widget draws its signed-out state
 * and never reads the stored rotation at all.
 *
 * And when there IS a credential, the store is read FOR THAT ACCOUNT. A rotation stamped with
 * any other account reads as empty (see `FeedRotationStore.rotation`), so the moment the
 * device's active account changes, this widget stops drawing the previous account's timeline —
 * without waiting for a refresh, a network round trip, or the server's own
 * `account_not_on_device` verdict to come back. Those are the belt; this is the braces.
 *
 * The content still comes only from the store, never from a fetch started here: composing
 * happens while the launcher waits, so the only thing that touches the network is
 * `FollowingRefreshWorker`.
 */
internal class FollowingWidget : GlanceAppWidget() {

    override val sizeMode: SizeMode = SizeMode.Exact

    /**
     * No per-widget state. Two following widgets show the same rotation from one app-scoped
     * store, so the default `PreferencesGlanceStateDefinition` would only create an empty
     * preferences file per widget id.
     */
    override val stateDefinition: GlanceStateDefinition<*>? = null

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        // No network, no keystore mint — just a read of what the app last provisioned. Null
        // means there has never been a credential, or it expired, or the SDK cleared it on a
        // sign-out or a switch.
        val accountId = OxyBackgroundSession.activeAccountId(context)

        if (accountId == null) {
            provideContent {
                MentionGlanceTheme {
                    FeedCardContent(
                        spec = FollowingCardSpec,
                        state = FeedCardState.SignedOut(R.string.mention_following_widget_signed_out),
                    )
                }
            }
            return
        }

        // Built once, outside the composition: `rotation` returns a fresh Flow per call, and
        // collecting a new instance on every recomposition would resubscribe to DataStore each
        // time.
        val state = FollowingStore.rotation(context, accountId)
            .map { rotation -> FeedCardState.Rotating(rotation) }
        val initial = state.first()

        provideContent {
            val current by state.collectAsState(initial = initial)
            MentionGlanceTheme {
                FeedCardContent(spec = FollowingCardSpec, state = current)
            }
        }
    }
}
