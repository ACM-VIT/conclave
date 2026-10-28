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

object NativeMeetingShare {

    fun buildShareIntent(subject: String, text: String, title: String): Intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, subject)
        putExtra(Intent.EXTRA_TEXT, text)
        if (title.isNotEmpty()) putExtra(Intent.EXTRA_TITLE, title)
    }

    fun shareMeetingLink(link: String, subject: String, text: String, title: String): Boolean {
        if (PermissionHelper.shouldSuppressShareFromNotificationPermissionPrompt()) {
            return false
        }

        val activity = UIApplication.shared.androidActivity
        val context = activity ?: ProcessInfo.processInfo.androidContext.applicationContext
        val chooser = Intent.createChooser(buildShareIntent(subject = subject, text = text, title = title), null)

        try {
            if (activity != null) {

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

object NativeExternalHandoff {

    fun supportsCustomTabs(context: Context): Boolean =
        CustomTabsClient.getPackageName(context, emptyList<String>()) != null

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

    fun openExternalApp(url: String): Boolean {
        val uri = Uri.parse(url)
        val action = when (uri.scheme?.lowercase()) {
            "tel" -> Intent.ACTION_DIAL
            "mailto" -> Intent.ACTION_SENDTO
            else -> Intent.ACTION_VIEW
        }
        return start(Intent(action, uri), ExternalHandoffKind.otherApp)
    }

    fun openSettings(intent: Intent): Boolean = start(intent, ExternalHandoffKind.systemSettings)

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
