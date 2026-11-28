package earth.mention.widgets.feedcard

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * WHEN a feed-card widget goes to the network, and whether anyone is looking.
 *
 * Both decisions are shared by every feed card, and both are pure functions rather than
 * `Worker` methods precisely because they are the decisions that give the widgets their
 * behaviour — a `Worker` method cannot be unit tested without a `Context`, and these are
 * exactly the rules worth testing.
 */

/**
 * How old the stored batch has to be before a tick re-fetches it instead of just rotating.
 *
 * Half an hour, for BOTH feeds, and the reasoning is the same on each: the widget shows five
 * posts, and neither Explore's ranked top five nor the top of a following timeline turns over
 * faster than that in a way five slots can show. Polling on every fifteen-minute tick would
 * spend twice the requests to receive largely the same five posts — and on the following
 * feed each of those requests also costs a token mint.
 */
internal val FETCH_INTERVAL_MS = TimeUnit.MINUTES.toMillis(30)

/**
 * Whether this tick should go to the network, or just move the rotation on.
 *
 * A rotation that has never been fetched always fetches. Otherwise it is a question of age,
 * and the future-timestamp guard is not paranoia: `currentTimeMillis` moves backwards
 * whenever the clock is corrected or a time zone changes, and without the absolute value a
 * widget could conclude its content was fetched hours from now and stop refreshing until real
 * time caught up.
 */
internal fun shouldFetchRotation(stored: FeedRotation, nowMs: Long): Boolean {
    if (stored.posts.isEmpty()) return true
    return abs(nowMs - stored.fetchedAtMs) >= FETCH_INTERVAL_MS
}

/**
 * Whether a widget of [receiver]'s kind is on a home screen at all.
 *
 * Asked of `AppWidgetManager` rather than of Glance because the answer is needed
 * synchronously. It takes the receiver class so each feed card asks about its OWN provider:
 * a user with only the trending-posts widget must not be paying for a following fetch, and
 * the reverse — which is the whole reason the two families keep separate schedules.
 */
internal fun anyPlaced(
    context: Context,
    receiver: Class<out GlanceAppWidgetReceiver>,
): Boolean {
    // Null where the device has no app-widget host at all (some TV and automotive builds);
    // nothing is placed there by definition.
    val manager = AppWidgetManager.getInstance(context) ?: return false
    return manager.getAppWidgetIds(ComponentName(context, receiver)).isNotEmpty()
}
