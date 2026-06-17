package conclave.module

import android.content.pm.ApplicationInfo
import skip.foundation.ProcessInfo

object AndroidRuntimeConfig {
    fun isDebuggable(): Boolean {
        val context = ProcessInfo.processInfo.androidContext
        return (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    }
}
