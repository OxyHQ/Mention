package earth.mention.widgets.posts

import android.content.Context
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.provideContent
import androidx.glance.state.GlanceStateDefinition
<<<<<<< HEAD
import earth.mention.widgets.feedcard.FeedCardContent
import earth.mention.widgets.feedcard.FeedCardState
import earth.mention.widgets.theme.MentionGlanceTheme
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
=======
import earth.mention.widgets.theme.MentionGlanceTheme
import kotlinx.coroutines.flow.first
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)

/**
 * The trending-posts widget: ONE post from Explore at a time, rotating.
 *
<<<<<<< HEAD
 * The content comes from [PostsStore], never from a fetch started here: composing
=======
 * Its declared sizes are [POSTS_WIDGET_SIZES] — three, one per design, and no more,
 * because `SizeMode.Responsive` puts every declared size into the single `RemoteViews`
 * the launcher receives and this widget's `RemoteViews` carries decoded bitmaps. See
 * `PostsBitmapBudget.kt` for the resulting worst-case payload.
 *
 * The content comes from [PostsRepository], never from a fetch started here: composing
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
 * happens while the launcher waits, so the only thing that touches the network is
 * `PostsRefreshWorker`. That separation is also what makes the widget survive an outage —
 * it draws whatever the store last held, with no notion of whether the fetch behind it
 * succeeded.
<<<<<<< HEAD
 *
 * It can never reach [FeedCardState.SignedOut]: Explore answers an unauthenticated request, so
 * this widget has no session to lose. That is the one behavioural difference from the following
 * widget, and it lives here rather than inside the shared card.
 */
internal class PostsWidget : GlanceAppWidget() {

    /**
     * [SizeMode.Exact], not `Responsive`, because THE PICTURE'S HEIGHT IS THE LEFTOVER SPACE.
     *
     * ## What Responsive was doing wrong
     *
     * It declared three sizes — 250×110, 250×180, 320×320 — and Glance hands the composition
     * the largest DECLARED size that fits, not the real one. So the card was measured against
     * a bucket: a 387 × 325dp placement (a four-by-three on a 480dpi phone, measured) composed
     * as though it were 320 × 320dp, and every height between two buckets spent the difference
     * on nothing. With a fixed image band that waste was invisible; now that the band is
     * derived from the height the rest of the card does not need ([imageSlotHeight]), composing
     * at a bucket would hand the derivation the wrong number and the change would do nothing at
     * all — the worst kind of shipped change.
     *
     * ## What it costs, and why it is affordable here
     *
     * `Responsive` exists to trade payload for recompositions, and this widget's payload is
     * the expensive kind: a `RemoteViews` carrying decoded bitmaps, which renders BLANK rather
     * than degrading if it overruns its Binder transaction. Responsive put an avatar in every
     * declared size and a thumbnail in each of the two with a slot — 275,820 bytes, which is
     * exactly what the launcher reported for a real placement (`dumpsys appwidget`,
     * `views_bitmap_memory`) and exactly what the arithmetic in `PostsBitmapBudget.kt`
     * predicts. `Exact` composes the sizes the launcher actually offers, which is at most a
     * portrait and a landscape one, so the same parcel carries two of each at worst instead of
     * five bitmaps. See [FEED_CARD_WORST_CASE_BITMAP_BYTES] for how the bound is derived once
     * there is no declared set to sum over.
     *
     * The breakpoints are not lost: `feedCardSize` still decides what the card SHOWS — the
     * lines of text, the handle, the controls — from the height. It now decides that, and the
     * size of the picture, from the height the widget really has.
     */
    override val sizeMode: SizeMode = SizeMode.Exact
=======
 */
internal class PostsWidget : GlanceAppWidget() {

    override val sizeMode: SizeMode = SizeMode.Responsive(POSTS_WIDGET_SIZES)
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)

    /**
     * No per-widget state. Two posts widgets show the same rotation from one app-scoped
     * store, so the default `PreferencesGlanceStateDefinition` would only create an empty
     * preferences file per widget id.
     */
    override val stateDefinition: GlanceStateDefinition<*>? = null

    override suspend fun provideGlance(context: Context, id: GlanceId) {
<<<<<<< HEAD
        // Built once, outside the composition: `PostsStore.rotation` returns a fresh
        // Flow per call, and collecting a new instance on every recomposition would
        // resubscribe to DataStore each time.
        val state = PostsStore.rotation(context, POSTS_ACCOUNT_ID)
            .map { rotation -> FeedCardState.Rotating(rotation) }
        val initial = state.first()

        provideContent {
            val current by state.collectAsState(initial = initial)
            MentionGlanceTheme {
                FeedCardContent(spec = PostsCardSpec, state = current)
=======
        // Built once, outside the composition: `PostsRepository.rotation` returns a fresh
        // Flow per call, and collecting a new instance on every recomposition would
        // resubscribe to DataStore each time.
        val rotation = PostsRepository.rotation(context)
        val initial = rotation.first()

        provideContent {
            val current by rotation.collectAsState(initial = initial)
            MentionGlanceTheme {
                PostsWidgetContent(current)
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
            }
        }
    }
}
