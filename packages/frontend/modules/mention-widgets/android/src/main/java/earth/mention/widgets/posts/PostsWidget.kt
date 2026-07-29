package earth.mention.widgets.posts

import android.content.Context
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.provideContent
import androidx.glance.state.GlanceStateDefinition
import earth.mention.widgets.theme.MentionGlanceTheme
import kotlinx.coroutines.flow.first

/**
 * The trending-posts widget: ONE post from Explore at a time, rotating.
 *
 * Its declared sizes are [POSTS_WIDGET_SIZES] — three, one per design, and no more,
 * because `SizeMode.Responsive` puts every declared size into the single `RemoteViews`
 * the launcher receives and this widget's `RemoteViews` carries decoded bitmaps. See
 * `PostsBitmapBudget.kt` for the resulting worst-case payload.
 *
 * The content comes from [PostsRepository], never from a fetch started here: composing
 * happens while the launcher waits, so the only thing that touches the network is
 * `PostsRefreshWorker`. That separation is also what makes the widget survive an outage —
 * it draws whatever the store last held, with no notion of whether the fetch behind it
 * succeeded.
 */
internal class PostsWidget : GlanceAppWidget() {

    override val sizeMode: SizeMode = SizeMode.Responsive(POSTS_WIDGET_SIZES)

    /**
     * No per-widget state. Two posts widgets show the same rotation from one app-scoped
     * store, so the default `PreferencesGlanceStateDefinition` would only create an empty
     * preferences file per widget id.
     */
    override val stateDefinition: GlanceStateDefinition<*>? = null

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        // Built once, outside the composition: `PostsRepository.rotation` returns a fresh
        // Flow per call, and collecting a new instance on every recomposition would
        // resubscribe to DataStore each time.
        val rotation = PostsRepository.rotation(context)
        val initial = rotation.first()

        provideContent {
            val current by rotation.collectAsState(initial = initial)
            MentionGlanceTheme {
                PostsWidgetContent(current)
            }
        }
    }
}
