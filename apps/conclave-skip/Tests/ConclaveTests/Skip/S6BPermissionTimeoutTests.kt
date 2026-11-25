package conclave.module

import android.os.Looper
import java.time.Duration
import java.util.ArrayDeque
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
@LooperMode(LooperMode.Mode.PAUSED)
class S6BPermissionTimeoutTests {
    @Test fun unansweredTimeoutDoesNotConsumeTheAnsweredFlagAndLateEmptyResultRemainsUnanswered() {
        val helper = PermissionHelper
        val helperClass = helper.javaClass
        val active = helperClass.getDeclaredField("activePermissionRequestCode").apply { isAccessible = true }
        val answered = helperClass.getDeclaredField("lastNotificationsPermissionRequestAnswered").apply { isAccessible = true }
        val waiters = helperClass.getDeclaredField("notificationsPermissionWaiters").apply { isAccessible = true }
        val schedule = helperClass.getDeclaredMethod("scheduleActivePermissionTimeout", Int::class.javaPrimitiveType).apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        val callbacks = waiters.get(helper) as ArrayDeque<(Boolean) -> Unit>
        val results = mutableListOf<Pair<Boolean, Boolean>>()
        callbacks.addLast { granted -> results.add(granted to helper.wasLastNotificationsPermissionRequestAnswered()) }
        active.set(helper, 1004)
        answered.set(helper, true)
        schedule.invoke(helper, 1004)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(120))
        assertEquals(listOf(false to false), results)
        assertFalse(helper.wasLastNotificationsPermissionRequestAnswered())
        helper.handleRequestPermissionsResult(1004, emptyArray(), intArrayOf())
        assertFalse(helper.wasLastNotificationsPermissionRequestAnswered())
        assertEquals(1, results.size)
    }
}
