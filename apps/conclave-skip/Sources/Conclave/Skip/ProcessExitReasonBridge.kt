package conclave.module

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import androidx.annotation.RequiresApi
import skip.foundation.ProcessInfo

object ProcessExitReasonBridge {
    internal const val PREFERENCES_NAME = "defaults"

    fun writeTaskRemovedMarker(context: Context): Boolean = writeMarker(context, System.currentTimeMillis())

    fun recordUserRequestedExit(snapshotSavedAtMillis: Double): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
        return try {
            recordRecentExits(ProcessInfo.processInfo.androidContext, snapshotSavedAtMillis)
        } catch (error: Throwable) {
            false
        }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    internal fun recordRecentExits(context: Context, snapshotSavedAtMillis: Double): Boolean {
        val manager = context.getSystemService(ActivityManager::class.java) ?: return false
        val millis = manager.getHistoricalProcessExitReasons(context.packageName, 0, 5)
            .mapNotNull { userRequestedMarkerMillis(it.reason, it.timestamp, snapshotSavedAtMillis) }
            .maxOrNull() ?: return false
        return writeMarker(context, millis)
    }

    internal fun userRequestedMarkerMillis(reason: Int, timestampMillis: Long, snapshotSavedAtMillis: Double): Long? {
        if (reason != ApplicationExitInfo.REASON_USER_REQUESTED) return null
        if (timestampMillis.toDouble() <= snapshotSavedAtMillis) return null
        return timestampMillis
    }

    private fun writeMarker(context: Context, millis: Long): Boolean =
        try {
            context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(MeetingResumeMarker.key, millis.toString())
                .commit()
        } catch (error: Throwable) {
            false
        }
}
