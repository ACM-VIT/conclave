package conclave.module

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ComponentName
import android.content.Context
import android.os.Looper
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowAccessibilityManager
import org.robolectric.util.ReflectionHelpers
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class S1bPostSwitchAccessBridgeTests {
    @Implements(AccessibilityManager::class)
    class FeedbackMaskShadow : ShadowAccessibilityManager() {
        @Implementation
        override fun getEnabledAccessibilityServiceList(feedbackTypeFlags: Int): List<AccessibilityServiceInfo> =
            super.getEnabledAccessibilityServiceList(feedbackTypeFlags).orEmpty()
                .filter { (it.feedbackType and feedbackTypeFlags) != 0 }
    }

    private val context: Context get() = RuntimeEnvironment.getApplication()
    private val manager: AccessibilityManager get() = context.getSystemService(AccessibilityManager::class.java)

    private fun service(feedbackType: Int, flags: Int, packageName: String, className: String): AccessibilityServiceInfo {
        val info = AccessibilityServiceInfo()
        info.feedbackType = feedbackType
        info.flags = flags
        ReflectionHelpers.setField(info, "mComponentName", ComponentName(packageName, className))
        return info
    }

    private fun switchAccess(flags: Int): AccessibilityServiceInfo = service(
        feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC, flags = flags,
        packageName = "com.google.android.marvin.talkback", className = "com.android.switchaccess.SwitchAccessService")

    private val measuredSwitchAccessFlags = AccessibilityServiceInfo.DEFAULT or
        AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
        AccessibilityServiceInfo.FLAG_REQUEST_FILTER_KEY_EVENTS or
        AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or
        AccessibilityServiceInfo.FLAG_ENABLE_ACCESSIBILITY_VOLUME

    private fun passwordManager(): AccessibilityServiceInfo = service(
        feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC,
        flags = AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS,
        packageName = "com.example.passwords", className = "com.example.passwords.AutofillAccessibilityService")

    private fun uiAutomation(): AccessibilityServiceInfo = service(
        feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC,
        flags = AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or
            AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
            AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS,
        packageName = "com.android.server.accessibility", className = "UiAutomation")

    private fun enable(enabled: Boolean, services: List<AccessibilityServiceInfo>) {
        val shadow = shadowOf(manager)
        shadow.setEnabled(enabled)
        shadow.setEnabledAccessibilityServiceList(services)
    }

    private fun stageCanAutoHide(access: ConclaveSystemAccessibility): Boolean {
        val screenReader = access.state().isScreenReaderRunning
        val blocker = ChromeAutoHidePolicy.effectiveBlocker(presenter = AutoHideBlocker.none,
            screenReader = screenReader, focusInChrome = false)
        return ChromeAutoHidePolicy.canAutoHide(blocker = blocker, voiceOver = screenReader,
            switchControl = false, focusInChrome = false)
    }

    @Test fun spokenServiceCountsAsAssistive() {
        val reader = service(
            feedbackType = AccessibilityServiceInfo.FEEDBACK_SPOKEN or AccessibilityServiceInfo.FEEDBACK_HAPTIC,
            flags = 0, packageName = "com.google.android.marvin.talkback",
            className = "com.google.android.marvin.talkback.TalkBackService")
        assertTrue(ConclaveSystemAccessibility.isAssistiveService(reader))
        enable(true, listOf(reader))
        assertTrue(ConclaveSystemAccessibility.assistiveServiceEnabled(manager))
    }

    @Test fun genericServiceThatFiltersKeyEventsCountsAsAssistive() {
        val keys = service(
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC,
            flags = AccessibilityServiceInfo.FLAG_REQUEST_FILTER_KEY_EVENTS,
            packageName = "com.example.keys", className = "com.example.keys.KeyInputService")
        assertFalse(keys.id.lowercase().contains("switchaccess"))
        assertTrue(ConclaveSystemAccessibility.isAssistiveService(keys))
        enable(true, listOf(keys))
        assertTrue(ConclaveSystemAccessibility.assistiveServiceEnabled(manager))
    }

    @Test fun switchAccessCountsByNameWithoutTheKeyFilterFlag() {
        val named = switchAccess(flags = AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS)
        assertEquals("com.google.android.marvin.talkback/com.android.switchaccess.SwitchAccessService", named.id)
        assertEquals(0, named.feedbackType and AccessibilityServiceInfo.FEEDBACK_SPOKEN)
        assertEquals(0, named.flags and AccessibilityServiceInfo.FLAG_REQUEST_FILTER_KEY_EVENTS)
        assertTrue(ConclaveSystemAccessibility.isAssistiveService(named))
        enable(true, listOf(named))
        assertTrue(ConclaveSystemAccessibility.assistiveServiceEnabled(manager))
    }

    @Test fun passwordManagerAndUiAutomationShapesDoNotCount() {
        val passwords = passwordManager()
        val automation = uiAutomation()
        assertFalse(ConclaveSystemAccessibility.isAssistiveService(passwords))
        assertFalse(ConclaveSystemAccessibility.isAssistiveService(automation))
        enable(true, listOf(passwords))
        assertFalse(ConclaveSystemAccessibility.assistiveServiceEnabled(manager))
        enable(true, listOf(automation))
        assertFalse(ConclaveSystemAccessibility.assistiveServiceEnabled(manager))
        enable(true, listOf(passwords, automation))
        assertFalse(ConclaveSystemAccessibility.assistiveServiceEnabled(manager))
    }

    @Test fun disabledManagerCountsNothing() {
        enable(false, listOf(switchAccess(flags = measuredSwitchAccessFlags)))
        assertFalse(ConclaveSystemAccessibility.assistiveServiceEnabled(manager))
        val access = ConclaveSystemAccessibility.read(context, context.resources.configuration)
        assertFalse(access.anyServiceEnabled)
        assertTrue(stageCanAutoHide(access))
    }

    @Test fun readWithSwitchAccessEnabledKeepsTheCallControlsVisible() {
        assertEquals(0xf1, measuredSwitchAccessFlags)
        enable(true, listOf(uiAutomation(), switchAccess(flags = measuredSwitchAccessFlags)))
        val access = ConclaveSystemAccessibility.read(context, context.resources.configuration)
        assertFalse(access.touchExploration)
        assertTrue(access.anyServiceEnabled)
        assertTrue(access.state().isScreenReaderRunning)
        assertTrue(access.state().blocksAutoHide)
        assertFalse(stageCanAutoHide(access))
    }

    @Test fun readWithOnlyAutomationServicesStillAutoHides() {
        enable(true, listOf(passwordManager(), uiAutomation()))
        val access = ConclaveSystemAccessibility.read(context, context.resources.configuration)
        assertFalse(access.anyServiceEnabled)
        assertFalse(access.state().isScreenReaderRunning)
        assertTrue(stageCanAutoHide(access))
    }

    @Test @Config(shadows = [FeedbackMaskShadow::class])
    fun switchAccessSurvivesTheServiceFeedbackMask() {
        enable(true, listOf(uiAutomation(), switchAccess(flags = measuredSwitchAccessFlags)))
        assertTrue(shadowOf(manager) is FeedbackMaskShadow)
        assertTrue(manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_SPOKEN).isEmpty())
        assertEquals(2, manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK).size)
        assertTrue(ConclaveSystemAccessibility.assistiveServiceEnabled(manager))
        val access = ConclaveSystemAccessibility.read(context, context.resources.configuration)
        assertTrue(access.anyServiceEnabled)
        assertFalse(stageCanAutoHide(access))
    }

    @Test fun switchAccessTurnedOnWhileAnotherServiceIsBoundRefreshesThroughTheServiceSettings() {
        val resolver = context.contentResolver
        val looper = shadowOf(Looper.getMainLooper())
        val settle = SystemAccessibilityServiceSettings.settleMillis
        val passwords = passwordManager()
        val switchAccessId = "com.google.android.marvin.talkback/com.android.switchaccess.SwitchAccessService"
        enable(true, listOf(passwords))
        val seen = mutableListOf<Boolean>()
        val stop = SystemAccessibilityServiceSettings.listen(context) {
            seen += ConclaveSystemAccessibility.read(context, context.resources.configuration).anyServiceEnabled
        }

        Settings.Secure.putString(resolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, "${passwords.id}:$switchAccessId")
        looper.idle()
        assertEquals(listOf(false), seen)
        shadowOf(manager).setEnabledAccessibilityServiceList(listOf(passwords, switchAccess(flags = measuredSwitchAccessFlags)))
        looper.idleFor(Duration.ofMillis(settle.first()))
        assertEquals(listOf(false, true), seen)
        looper.idleFor(Duration.ofMillis(settle.last()))
        assertEquals(1 + settle.size, seen.size)
        assertTrue(seen.last())
        assertTrue(manager.isEnabled)

        Settings.Secure.putString(resolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, passwords.id)
        looper.idle()
        assertTrue(seen.last())
        shadowOf(manager).setEnabledAccessibilityServiceList(listOf(passwords))
        looper.idleFor(Duration.ofMillis(settle.last()))
        assertFalse(seen.last())

        Settings.Secure.putString(resolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, "${passwords.id}:$switchAccessId")
        looper.idle()
        val delivered = seen.size
        stop()
        shadowOf(manager).setEnabledAccessibilityServiceList(listOf(passwords, switchAccess(flags = measuredSwitchAccessFlags)))
        looper.idleFor(Duration.ofMillis(settle.last() + 1_000L))
        Settings.Secure.putString(resolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, passwords.id)
        looper.idle()
        assertEquals(delivered, seen.size)
    }
}
