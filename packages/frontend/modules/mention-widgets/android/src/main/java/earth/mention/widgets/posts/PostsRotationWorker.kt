package earth.mention.widgets.posts

import android.content.Context
import android.os.PowerManager
import androidx.glance.appwidget.updateAll
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * The tick that makes the rotation VISIBLE.
 *
 * WHY IT IS A SEPARATE JOB FROM THE REFRESH. `PostsRefreshWorker` both fetches and advances,
 * on the shortest interval WorkManager offers periodic work — fifteen minutes, its own
 * documented floor — and the provider's `updatePeriodMillis` is clamped to thirty. Nobody
 * looking at a home screen ever saw the card move, so a rotation of five posts behaved
 * exactly like a widget stuck on one. On a surface with no gestures at all, that left the
 * card with no way to show its other four posts.
 *
 * The opening is that ADVANCING COSTS NO NETWORK: the posts are already in the store, so a
 * tick here is a cursor write and a `RemoteViews` update. That decouples the two cadences
 * completely — the fetch stays exactly where it was, and rotation runs on its own much
 * faster clock.
 *
 * A SELF-RESCHEDULING ONE-TIME REQUEST, not periodic work, because only a one-time request
 * takes an arbitrary `setInitialDelay` and can therefore run below the fifteen-minute floor.
 * Each run enqueues the next; nothing runs the chain but the chain.
 *
 * IT STOPS BY NOT RESCHEDULING, which is the whole of its lifecycle. Two conditions end it:
 * the last widget being removed, and the screen going off. Neither needs a cancel from
 * anywhere — the link that notices simply does not enqueue another, and the chain is over.
 * (`PostsRefreshScheduler.cancel` still cancels it explicitly on `onDisabled`, for the run
 * that is already queued when the last widget disappears.)
 */
internal class PostsRotationWorker(
    appContext: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(appContext, parameters) {

    override suspend fun doWork(): Result {
        if (
            !shouldRotate(
                placed = anyPlaced(applicationContext),
                interactive = isScreenInteractive(applicationContext),
            )
        ) {
            // Deliberately does NOT reschedule. `Result.success()` rather than `failure()`
            // because nothing went wrong: there is simply nobody to rotate for.
            return Result.success()
        }

        PostsRepository.advance(applicationContext)
        PostsWidget().updateAll(applicationContext)

        // The next link, enqueued only after this one did its work — so a chain can never
        // outrun itself, and a run that returns early above ends it.
        PostsRefreshScheduler.restartRotation(applicationContext)
        return Result.success()
    }
}

/**
 * Whether this tick should move the rotation on, or end the chain.
 *
 * A top-level function rather than a method for the same reason as `shouldFetchRotation`: it
 * is the decision that gives the job its behaviour, and a `Worker` method cannot be unit
 * tested without a `Context`.
 *
 * [interactive] IS THE BATTERY ARGUMENT, and it is the difference between a feature and a
 * complaint. Cycling a widget while the screen is off spends wake-ups redrawing something
 * nobody can see; the rotation exists to be watched, so it runs only while there is somebody
 * who could be watching.
 *
 * [placed] covers the queued-run case: the chain is cancelled when the last widget is
 * removed, but a link can already be queued at that moment.
 */
internal fun shouldRotate(placed: Boolean, interactive: Boolean): Boolean = placed && interactive

/**
 * Whether the screen is on and the device is being used.
 *
 * `false` where the service cannot be reached at all, which is the conservative direction: a
 * device that cannot say whether anyone is looking gets no timer and still rotates on the
 * refresh tick, rather than cycling in someone's pocket.
 */
internal fun isScreenInteractive(context: Context): Boolean =
    context.getSystemService(PowerManager::class.java)?.isInteractive ?: false

/**
 * Shortest and longest rotation interval the widget will honour, in seconds.
 *
 * These are RAILS, not the setting — the interval itself lives in
 * `R.integer.mention_posts_widget_rotate_seconds` so a build can retune it. They exist
 * because that resource can be overridden by the app module, and neither end of the range is
 * survivable: a one-second rotation is a card that changes while it is being read and a
 * wake-up every second, while anything past five minutes is slower than the refresh tick this
 * job exists to beat.
 */
private const val MIN_ROTATION_SECONDS = 5
private const val MAX_ROTATION_SECONDS = 300

/**
 * The configured interval, brought inside [MIN_ROTATION_SECONDS] … [MAX_ROTATION_SECONDS].
 *
 * A missing or nonsensical resource value (zero, negative) becomes the floor rather than an
 * exception or a busy loop: this runs in a `BroadcastReceiver`'s process on someone's home
 * screen, and the failure mode for a bad number must be a slightly wrong cadence.
 */
internal fun rotationIntervalSeconds(configuredSeconds: Int): Long =
    configuredSeconds.coerceIn(MIN_ROTATION_SECONDS, MAX_ROTATION_SECONDS).toLong()
