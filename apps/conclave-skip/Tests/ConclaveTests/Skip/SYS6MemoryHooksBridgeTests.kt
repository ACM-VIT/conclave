package conclave.module

import android.content.ComponentCallbacks2
import android.graphics.Bitmap
import coil3.SingletonImageLoader
import coil3.asImage
import coil3.memory.MemoryCache
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class SYS6MemoryHooksBridgeTests {
    @Test fun theTranspiledObserverRunsEachSubscriberOnceInIdOrder() {
        val pressure = MemoryPressure()
        val calls = mutableListOf<String>()
        pressure.subscribe("transcript") { calls.add("transcript") }
        pressure.subscribe("chat.images") { calls.add("chat.images") }
        pressure.signal()
        pressure.unsubscribe("transcript")
        pressure.signal()
        assertEquals(listOf("chat.images", "transcript", "chat.images"), calls)
        assertEquals(2, pressure.signalCount)
        assertEquals(listOf("chat.images"), pressure.subscriberIds.toList())
    }

    @Test fun aPressureSignalEmptiesTheChatImageMemoryCache() {
        val cache = SingletonImageLoader.get(RuntimeEnvironment.getApplication()).memoryCache!!
        val bitmap = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888)
        cache[MemoryCache.Key("chat-image")] = MemoryCache.Value(bitmap.asImage())
        assertEquals(setOf(MemoryCache.Key("chat-image")), cache.keys)
        MemoryPressureHooks.install()
        MemoryPressure.shared.signal()
        assertTrue(cache.keys.isEmpty())
    }

    @Suppress("DEPRECATION")
    @Test fun runningLowAndEveryHigherLevelIncludingUiHiddenReleaseMemory() {
        assertFalse(conclaveShouldReleaseMemory(ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE))
        assertTrue(conclaveShouldReleaseMemory(ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW))
        assertTrue(conclaveShouldReleaseMemory(ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL))
        assertTrue(conclaveShouldReleaseMemory(ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN))
        assertTrue(conclaveShouldReleaseMemory(ComponentCallbacks2.TRIM_MEMORY_BACKGROUND))
        assertTrue(conclaveShouldReleaseMemory(ComponentCallbacks2.TRIM_MEMORY_MODERATE))
        assertTrue(conclaveShouldReleaseMemory(ComponentCallbacks2.TRIM_MEMORY_COMPLETE))
    }
}
