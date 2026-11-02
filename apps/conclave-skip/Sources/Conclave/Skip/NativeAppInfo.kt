package conclave.module

import android.content.Context
import android.content.Intent
import android.net.Uri
import skip.foundation.ProcessInfo

internal object NativeAppInfo {
    fun versionName(): String = try {
        val context = ProcessInfo.processInfo.androidContext
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
    } catch (_: Throwable) {
        ""
    }

    fun storeIntent(url: String): Intent =
        Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    fun openStoreListing(url: String) {
        openStoreListing(ProcessInfo.processInfo.androidContext, url)
    }

    fun openStoreListing(context: Context, url: String): Boolean = try {
        context.startActivity(storeIntent(url))
        true
    } catch (_: Throwable) {
        false
    }
}
