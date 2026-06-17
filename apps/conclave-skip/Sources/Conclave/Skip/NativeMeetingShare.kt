package conclave.module

import android.content.Intent
import skip.foundation.ProcessInfo
import skip.ui.UIApplication

object NativeMeetingShare {
    fun shareMeetingLink(link: String, roomId: String) {
        if (PermissionHelper.shouldSuppressShareFromNotificationPermissionPrompt()) {
            return
        }

        val activity = UIApplication.shared.androidActivity
        val context = activity ?: ProcessInfo.processInfo.androidContext
        val message = "Join me in this Conclave room.\n$link"
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "Conclave meeting")
            putExtra(Intent.EXTRA_TEXT, message)
        }
        val chooser = Intent.createChooser(shareIntent, "Share meeting link")
        if (activity == null) {
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

        try {
            context.startActivity(chooser)
        } catch (t: Throwable) {
            debugLog("[Share] Failed to open Android share sheet: ${t}")
            ClipboardHelper.copyToClipboard(text = link, label = "Meeting link")
        }
    }
}
