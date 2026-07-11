package conclave.module

import android.content.Intent
import skip.foundation.ProcessInfo
import skip.ui.UIApplication

object NativeMeetingShare {
    fun shareMeetingLink(link: String, roomId: String): Boolean {
        if (PermissionHelper.shouldSuppressShareFromNotificationPermissionPrompt()) {
            return false
        }

        val activity = UIApplication.shared.androidActivity
        val context = activity ?: ProcessInfo.processInfo.androidContext.applicationContext
        val message = "Join me in this Conclave room.\n$link"
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "Conclave meeting")
            putExtra(Intent.EXTRA_TEXT, message)
        }
        val chooser = Intent.createChooser(shareIntent, "Share meeting link")

        try {
            if (activity != null) {
                // Launching a chooser calls onUserLeaveHint just like Home on
                // several Android builds. Mark this as an intentional external
                // activity so the call stays full-screen behind the chooser
                // instead of being torn into PiP.
                PipManager.suppressNextAutoEnter("meeting_share")
            } else {
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(chooser)
            return true
        } catch (t: Throwable) {
            PipManager.restoreAutoEnterAfterExternalActivity()
            debugLog("[Share] Failed to open Android share sheet: ${t}")
            ClipboardHelper.copyToClipboard(text = link, label = "Meeting link")
            return true
        }
    }

    fun shareText(title: String, text: String): Boolean {
        val activity = UIApplication.shared.androidActivity
        val context = activity ?: ProcessInfo.processInfo.androidContext.applicationContext
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, title)
            putExtra(Intent.EXTRA_TEXT, text)
        }
        val chooser = Intent.createChooser(shareIntent, title)

        try {
            if (activity != null) {
                PipManager.suppressNextAutoEnter("transcript_share")
            } else {
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(chooser)
            return true
        } catch (t: Throwable) {
            PipManager.restoreAutoEnterAfterExternalActivity()
            debugLog("[Share] Failed to share text: ${t}")
            ClipboardHelper.copyToClipboard(text = text, label = title)
            return true
        }
    }
}
