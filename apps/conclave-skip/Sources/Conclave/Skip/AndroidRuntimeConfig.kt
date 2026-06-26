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

    fun isCurrentPackageSuspended(): Boolean {
        val context = ProcessInfo.processInfo.androidContext
        return try {
            val applicationInfo = currentApplicationInfo() ?: context.applicationInfo
            @Suppress("DEPRECATION")
            (applicationInfo.flags and ApplicationInfo.FLAG_SUSPENDED) != 0
        } catch (_: Throwable) {
            false
        }
    }

    fun isProbablyEmulator(): Boolean {
        val fingerprint = Build.FINGERPRINT.lowercase()
        val model = Build.MODEL.lowercase()
        val manufacturer = Build.MANUFACTURER.lowercase()
        val brand = Build.BRAND.lowercase()
        val device = Build.DEVICE.lowercase()
        val product = Build.PRODUCT.lowercase()
        val hardware = Build.HARDWARE.lowercase()

        return fingerprint.startsWith("generic") ||
            fingerprint.contains("emulator") ||
            model.contains("google_sdk") ||
            model.contains("emulator") ||
            model.contains("android sdk built for") ||
            manufacturer.contains("genymotion") ||
            (brand.startsWith("generic") && device.startsWith("generic")) ||
            product.contains("sdk") ||
            product.contains("emulator") ||
            product.contains("vbox") ||
            hardware.contains("goldfish") ||
            hardware.contains("ranchu") ||
            hardware.contains("vbox")
    }

    fun metadataValue(forKey: String): String? {
        val applicationInfo = currentApplicationInfo() ?: return null

        val value = applicationInfo.metaData?.get(forKey)?.toString()?.trim()
        return value?.takeIf { it.isNotEmpty() && it != "null" }
    }

    private fun currentApplicationInfo(): ApplicationInfo? {
        val context = ProcessInfo.processInfo.androidContext
        return try {
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
            null
        }
    }
}
