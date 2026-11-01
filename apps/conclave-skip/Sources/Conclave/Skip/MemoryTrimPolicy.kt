package conclave.module

import android.content.ComponentCallbacks2

@Suppress("DEPRECATION")
fun conclaveShouldReleaseMemory(level: Int): Boolean =
    level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW
