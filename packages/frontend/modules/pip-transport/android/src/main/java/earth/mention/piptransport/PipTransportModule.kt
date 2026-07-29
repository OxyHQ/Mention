package earth.mention.piptransport

import android.app.Activity
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import androidx.core.os.bundleOf
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.records.Required
import expo.modules.kotlin.types.Enumerable

/**
 * Next / previous buttons inside the Android Picture-in-Picture window.
 *
 * Android is the one platform where an app may add its own controls to the OS
 * window, through `PictureInPictureParams.Builder().setActions(...)`, and
 * expo-video does not expose it: its only params it ever sets are the source
 * rect hint, the aspect ratio and the auto-enter flag. This module fills that
 * gap and nothing else — it never enters, leaves or configures PiP, it only
 * attaches actions to whatever window expo-video is driving.
 *
 * A press travels back as a broadcast, because a `RemoteAction` can only carry a
 * `PendingIntent`: the button fires our own explicit, app-scoped broadcast, the
 * receiver registered here turns it into the `onAction` event, and JS decides
 * what "next" means. The receiver exists for exactly as long as JS is listening,
 * so it is never left behind by a screen that unmounted.
 */
class PipTransportModule : Module() {
  /** The live registration, or `null` while nothing is listening. */
  private var registration: ReceiverRegistration? = null

  override fun definition() = ModuleDefinition {
    Name("MentionPipTransport")

    Events(ACTION_EVENT)

    /**
     * How many actions this device's PiP window will show. Three on most, but it
     * is a runtime query on the current activity, not a constant — and `0` is
     * the honest answer wherever there is no PiP at all (no activity yet, below
     * API 26, or a device without the feature), which keeps every caller on one
     * code path instead of a separate capability check.
     */
    Function("getMaxActions") {
      val activity = appContext.currentActivity
      if (activity == null ||
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
        !activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
      ) {
        0
      } else {
        activity.maxNumPictureInPictureActions
      }
    }

    AsyncFunction("setActions") { actions: List<PipActionRecord> ->
      applyActions(actions)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("clearActions") {
      applyActions(emptyList())
    }.runOnQueue(Queues.MAIN)

    OnStartObserving(ACTION_EVENT) { startObserving() }
    OnStopObserving(ACTION_EVENT) { stopObserving() }
    // A module torn down while JS still held a listener never gets
    // `OnStopObserving`, so this is what keeps the receiver from outliving it.
    OnDestroy { stopObserving() }
  }

  /**
   * Publish (or, with an empty list, withdraw) the window's actions.
   *
   * Every failure path throws rather than returning quietly: a caller that asked
   * for buttons and silently got none has no way to tell that apart from working
   * correctly.
   */
  private fun applyActions(actions: List<PipActionRecord>) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      throw PictureInPictureUnsupportedException()
    }
    val activity = appContext.currentActivity ?: throw Exceptions.MissingActivity()
    if (!activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
      throw PictureInPictureUnsupportedException()
    }

    // ONLY `setActions` is set on this builder, and that is load-bearing:
    // Android merges successive `setPictureInPictureParams` calls field by field
    // (`PictureInPictureParams.copyOnlySet`), so leaving every other field unset
    // means the aspect ratio, source-rect hint and auto-enter flag expo-video
    // keeps pushing survive this call — and its later pushes, which set only
    // those, survive ours.
    val params = PictureInPictureParams.Builder()
      .setActions(actions.mapIndexed { index, action -> action.toRemoteAction(activity, index) })
      .build()

    try {
      activity.setPictureInPictureParams(params)
    } catch (cause: IllegalStateException) {
      // Thrown when the activity is not declared `supportsPictureInPicture`.
      // There is no API to ask in advance, so the throw IS the capability check.
      throw PictureInPictureUnsupportedException(cause)
    }
  }

  @RequiresApi(Build.VERSION_CODES.O)
  private fun PipActionRecord.toRemoteAction(activity: Activity, requestCode: Int): RemoteAction {
    val intent = Intent(ACTION_BROADCAST)
      // Explicit to our own package: an implicit broadcast would be offered to
      // every app on the device, and is refused outright from API 26 anyway.
      .setPackage(activity.packageName)
      .putExtra(EXTRA_ACTION_ID, id.value)

    val pendingIntent = PendingIntent.getBroadcast(
      activity,
      // Distinct per action. PendingIntents are deduplicated on request code
      // plus `Intent.filterEquals`, which ignores extras — so a shared request
      // code would give every button the id of whichever was created first.
      requestCode,
      intent,
      // IMMUTABLE is required from API 31 and correct below it: nothing outside
      // this app may fill anything in. UPDATE_CURRENT is what lets a re-issued
      // list rewrite the extras of the intent already cached under this code.
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    return RemoteAction(
      Icon.createWithResource(activity, id.drawableResId),
      title,
      // Content description, i.e. what TalkBack announces. The title is already
      // the localized "Next video" / "Previous video", so there is nothing more
      // specific to add.
      title,
      pendingIntent,
    )
  }

  private fun startObserving() {
    if (registration != null) return
    val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(receivedContext: Context?, intent: Intent?) {
        val id = intent?.getStringExtra(EXTRA_ACTION_ID) ?: return
        sendEvent(ACTION_EVENT, bundleOf(EXTRA_ACTION_ID to id))
      }
    }
    // NOT_EXPORTED: the only sender is this app's own PendingIntent, which the
    // system fires under our identity, so nothing outside needs to reach it.
    ContextCompat.registerReceiver(
      context,
      receiver,
      IntentFilter(ACTION_BROADCAST),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    registration = ReceiverRegistration(context, receiver)
  }

  private fun stopObserving() {
    val current = registration ?: return
    registration = null
    // Must unregister through the SAME context that registered it — hence the
    // pair. A context torn down first makes this throw, which is worth a line in
    // the log and nothing more: the receiver died with it either way.
    runCatching { current.context.unregisterReceiver(current.receiver) }
      .onFailure { Log.w(TAG, "Picture-in-Picture action receiver was already gone", it) }
  }

  private class ReceiverRegistration(
    val context: Context,
    val receiver: BroadcastReceiver,
  )

  private companion object {
    const val TAG = "MentionPipTransport"

    /** The single event JS listens on; its payload is `{ id }`. */
    const val ACTION_EVENT = "onAction"

    /** Action of the app-internal broadcast a PiP button fires. */
    const val ACTION_BROADCAST = "earth.mention.piptransport.ACTION"

    /** Names the pressed action, both on the intent and in the event payload. */
    const val EXTRA_ACTION_ID = "id"
  }
}

/**
 * The transport controls this module knows how to draw. Closed on purpose: the
 * icon is ours to supply, so an open-ended id would mean shipping Android
 * resource names through the JS bridge.
 */
enum class PipActionId(val value: String) : Enumerable {
  PREVIOUS("previous"),
  NEXT("next"),
  ;

  val drawableResId: Int
    get() = when (this) {
      PREVIOUS -> R.drawable.mention_pip_action_previous
      NEXT -> R.drawable.mention_pip_action_next
    }
}

class PipActionRecord : Record {
  // The initialisers are placeholders: records are reflection-constructed empty
  // and then filled, and `@Required` is what actually rejects a missing field.
  @Field
  @Required
  var id: PipActionId = PipActionId.NEXT

  @Field
  @Required
  var title: String = ""
}

internal class PictureInPictureUnsupportedException(cause: Throwable? = null) : CodedException(
  "This activity cannot show Picture-in-Picture actions",
  cause,
)
