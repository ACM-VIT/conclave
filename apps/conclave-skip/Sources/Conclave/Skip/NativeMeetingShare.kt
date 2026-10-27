package conclave.module

import android.content.Intent
import skip.foundation.ProcessInfo
import skip.ui.UIApplication

/*
 * ENT-8 (S20 0.7 SC21, S10 11 d; RECONCILE R14): the Android share for meeting links. One payload on every surface:
 * EXTRA_SUBJECT is the F00 `ds_share_subject`, EXTRA_TEXT the F00 `ds_share_text` with the URL, EXTRA_TITLE the room
 * label (the API 29+ Sharesheet preview), and no chooser title. The native surfaces pass the strings they resolved
 * (`shareMeetingLink(link, subject, text, title)`); the legacy two-argument call resolves the same resources by name.
 * No EXTRA_IS_SENSITIVE (a meeting link is not secret). `PipManager.suppressNextAutoEnter` stays: a chooser fires
 * onUserLeaveHint on several Android builds and must not tear a call into PiP.
 */
object NativeMeetingShare {
    /** The ACTION_SEND intent (no chooser), so tests can read its extras. */
    fun buildShareIntent(subject: String, text: String, title: String): Intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, subject)
        putExtra(Intent.EXTRA_TEXT, text)
        if (title.isNotEmpty()) putExtra(Intent.EXTRA_TITLE, title)
    }

    /** SC21: the native surfaces' share with the resolved F00 strings and the room label as EXTRA_TITLE. */
    fun shareMeetingLink(link: String, subject: String, text: String, title: String): Boolean {
        if (PermissionHelper.shouldSuppressShareFromNotificationPermissionPrompt()) {
            return false
        }

        val activity = UIApplication.shared.androidActivity
        val context = activity ?: ProcessInfo.processInfo.androidContext.applicationContext
        val chooser = Intent.createChooser(buildShareIntent(subject = subject, text = text, title = title), null)

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
            ClipboardHelper.copyToClipboard(text = link, label = conclaveStringOf(context, "pm_clip_label"))
            return true
        }
    }

    /** The legacy call (MeetingShare, legacy screens): the same F00 payload, resolved by name from app resources. */
    fun shareMeetingLink(link: String, roomId: String): Boolean {
        val context = UIApplication.shared.androidActivity ?: ProcessInfo.processInfo.androidContext.applicationContext
        return shareMeetingLink(
            link = link,
            subject = conclaveStringOf(context, "ds_share_subject"),
            text = conclaveStringOf(context, "ds_share_text", link),
            title = roomId,
        )
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
