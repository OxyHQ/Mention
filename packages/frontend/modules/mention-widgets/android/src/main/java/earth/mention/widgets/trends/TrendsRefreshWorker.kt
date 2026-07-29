package earth.mention.widgets.trends

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import org.json.JSONException
import java.io.IOException

/**
 * Fetches the trending batch and hands it to the widgets.
 *
 * ONE worker for all three variants: they read the same store, so a fetch per variant
 * would be the same request three times over.
 *
 * The whole failure contract lives here, and it has one rule: this worker never
 * writes an empty or partial result. A fetch that does not produce a parsed list
 * leaves the store exactly as it was, so the widgets keep drawing the last
 * trends they had — stale content being the correct thing to show when the network
 * is gone, and a blank widget the wrong one.
 */
internal class TrendsRefreshWorker(
    appContext: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(appContext, parameters) {

    override suspend fun doWork(): Result {
        // The periodic job is cancelled when the last widget is removed, but a
        // run can already be queued when that happens, and a one-off nudge from
        // JS does not know whether the user has a widget at all. Checking here
        // covers both without either caller having to.
        if (!TrendsWidgets.anyPlaced(applicationContext)) {
            return Result.success()
        }

        return try {
            val trends = TrendsApi.fetch(applicationContext)
            TrendsRepository.save(applicationContext, trends)
            TrendsWidgets.redrawAll(applicationContext)
            Result.success()
        } catch (cause: IOException) {
            // Transient by nature — no network, a timeout, a 5xx. Worth another go.
            Log.w(TAG, "Could not refresh the trends widget", cause)
            if (runAttemptCount >= MAX_ATTEMPTS) Result.failure() else Result.retry()
        } catch (cause: JSONException) {
            // The response was not the shape this build knows how to read.
            // Retrying would fetch the same body again, so it stops here and the
            // widget keeps its last good content until the contract is fixed.
            Log.e(TAG, "GET /trending returned a body the widget cannot read", cause)
            Result.failure()
        }
    }

    private companion object {
        const val TAG = "MentionTrendsWidget"

        /**
         * Attempts before a run gives up. `runAttemptCount` is zero-based, so
         * this allows the first try plus two retries; past that the periodic
         * schedule is the next opportunity anyway, and continuing to back off
         * would only keep waking the device on a network that is still down.
         */
        const val MAX_ATTEMPTS = 3
    }
}
