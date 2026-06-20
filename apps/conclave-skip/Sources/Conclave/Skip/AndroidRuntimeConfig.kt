package conclave.module

import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import skip.foundation.ProcessInfo

object AndroidRuntimeConfig {
    fun isDebuggable(): Boolean {
        val context = ProcessInfo.processInfo.androidContext
        return (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    }

    fun metadataValue(forKey: String): String? {
        val context = ProcessInfo.processInfo.androidContext
        val applicationInfo = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.packageManager.getApplicationInfo(
                    context.packageName,
                    PackageManager.ApplicationInfoFlags.of(PackageManager.GET_META_DATA.toLong())
                )
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
            }
        } catch (_: Throwable) {
            return null
        }

        val value = applicationInfo.metaData?.get(forKey)?.toString()?.trim()
        return value?.takeIf { it.isNotEmpty() && it != "null" }
    }
}
