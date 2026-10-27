package conclave.module

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import skip.foundation.ProcessInfo
import skip.ui.UIApplication

/*
 * ENT-8 (S20 0.7 SC21, S10 11 d; RECONCILE R14): the Android share for meeting links. One payload on every surface:
 * EXTRA_SUBJECT is the F00 `ds_share_subject`, EXTRA_TEXT the F00 `ds_share_text` with the URL, EXTRA_TITLE the room
 * label (the API 29+ Sharesheet preview), and no chooser title. The native surfaces pass the strings they resolved
 * (`shareMeetingLink(link, subject, text, title)`); the legacy two-argument call resolves the same resources by name.
 * No sensitive-content extra (a meeting link is not secret). `PipManager.suppressNextAutoEnter` stays: a chooser fires
 * onUserLeaveHint on several Android builds and must not tear a call into PiP.
 *
 * SYS-8 (S70 8 d): the transcript share carries its title as EXTRA_TITLE too, and both shares keep their suppression
 * reasons ("meeting_share", "transcript_share"), which ExternalHandoffPolicy names for the sys.pipSuppressions readout.
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
            // The API 29+ Sharesheet preview title, like the meeting link share.
            if (title.isNotEmpty()) putExtra(Intent.EXTRA_TITLE, title)
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

/*
 * SYS-8 (S70 8 d; RECONCILE R25; S40 3 h, Q16): every activity Conclave starts outside the call screen goes through
 * one place, so PiP auto-enter is suppressed for each of them (ExternalHandoffPolicy: never for Settings, where
 * auto-enter keeps the call visible over the switch) and restored when the launch fails; resuming restores it
 * otherwise (PipManager.handleActivityResumed). http and https open in Custom Tabs launched from the call activity, so
 * the tab sits on the call task and the camera keeps capturing under the camera foreground-service type.
 */
object NativeExternalHandoff {
    /** A Custom Tabs browser is installed (needs the manifest `<queries>` entry for CustomTabsService on API 30+). */
    fun supportsCustomTabs(context: Context): Boolean =
        CustomTabsClient.getPackageName(context, emptyList<String>()) != null

    /** http and https in Custom Tabs on the call task (S40 3 h). Returns false when nothing could open it. */
    fun openWebLink(url: String): Boolean {
        val activity = UIApplication.shared.androidActivity ?: return openExternalApp(url)
        val uri = Uri.parse(url)
        PipManager.suppressForExternalHandoff(ExternalHandoffKind.webLink)
        return try {
            CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, uri)
            true
        } catch (t: ActivityNotFoundException) {
            PipManager.restoreAutoEnterAfterExternalActivity()
            debugLog("[Link] No browser for a web link: ${t}")
            false
        } catch (t: Throwable) {
            PipManager.restoreAutoEnterAfterExternalActivity()
            debugLog("[Link] Failed to open a web link: ${t}")
            false
        }
    }

    /**
     * A link that opens another app, after the S40 confirmation: `tel:` only fills the dialer (ACTION_DIAL, never a
     * placed call), `mailto:` composes (ACTION_SENDTO), anything else is ACTION_VIEW (also the fallback for a web link
     * when no browser supports Custom Tabs).
     */
    fun openExternalApp(url: String): Boolean {
        val uri = Uri.parse(url)
        val action = when (uri.scheme?.lowercase()) {
            "tel" -> Intent.ACTION_DIAL
            "mailto" -> Intent.ACTION_SENDTO
            else -> Intent.ACTION_VIEW
        }
        return start(Intent(action, uri), ExternalHandoffKind.otherApp)
    }

    /** App details, notification, channel or Wi-Fi settings: never suppressed, so auto-enter keeps the call visible. */
    fun openSettings(intent: Intent): Boolean = start(intent, ExternalHandoffKind.systemSettings)

    /** Starts an external activity with the hand-off's suppression; a failed start restores auto-enter at once. */
    internal fun start(intent: Intent, kind: ExternalHandoffKind): Boolean {
        val activity: Activity? = UIApplication.shared.androidActivity
        val context: Context = activity ?: ProcessInfo.processInfo.androidContext.applicationContext
        if (activity == null) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        PipManager.suppressForExternalHandoff(kind)
        return try {
            context.startActivity(intent)
            true
        } catch (t: Throwable) {
            PipManager.restoreAutoEnterAfterExternalActivity()
            debugLog("[Handoff] Failed to start ${kind.rawValue}: ${t}")
            false
        }
    }
}
